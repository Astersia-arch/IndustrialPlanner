import type { BlueprintPlannerRequest, BlueprintPlannerResult, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { SimulationBlueprintRunReport } from "@/domain/simulation";
import { BLUEPRINT_SCHEMA_VERSION } from "@/domain/document/blueprint-document";
import type { PlannerCandidate } from "./candidate";
import { validatePlannerRequest } from "./production-network";
import { PlannerSearchPortfolio, type PlannerPortfolioSnapshot } from "./search-portfolio";
import { restorePlannerSeed } from "./search-seed";

export const PLANNER_ALGORITHM_VERSION = "compact-portfolio-2";

export interface PlannerCheckpoint {
  attempt: number;
  evaluations: number;
  portfolio: PlannerPortfolioSnapshot;
  best: { candidate: PlannerCandidate; report: SimulationBlueprintRunReport } | null;
  pendingCandidate: PlannerCandidate | null;
  result: BlueprintPlannerResult | null;
  savedBlueprintId: string | null;
}

export function emptyPlannerCheckpoint(): PlannerCheckpoint {
  return { attempt: 0, evaluations: 0, portfolio: { pools: [] }, best: null, pendingCandidate: null,
    result: null, savedBlueprintId: null };
}

/** 2026-09-30：仅明确支持的旧算法允许保留输入、重置搜索；不猜测未知版本顺序。 */
export function restorePlannerTaskFile(value: BlueprintPlannerTaskFile, registry: RegistryContract): BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint } {
  if (value?.formatVersion !== 1 || value.algorithmVersion !== "compact-portfolio-1") return parsePlannerTaskFile(value, registry);
  validateTaskRequest(registry, value.request);
  return parsePlannerTaskFile({ ...value, algorithmVersion: PLANNER_ALGORITHM_VERSION,
    checkpoint: emptyPlannerCheckpoint(), progress: { taskId: value.taskId, status: "waiting", phase: "preparing",
      startedAt: value.progress?.startedAt, elapsedMs: 0, estimatedProgress: null, candidateCount: 0,
      evaluatedProposals: 0, roundEvaluatedProposals: 0, validatedCandidateCount: 0, bestArea: null,
      message: "算法已更新，旧计算进度已重置，请重新开始计算。" } }, registry);
}

/** JSON 边界验证失败时拒绝导入，不能悄悄丢弃检查点后从头计算。 */
export function parsePlannerTaskFile(value: unknown, registry: RegistryContract): BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint } {
  try {
    const file = structuredClone(value) as BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint };
    if (file?.formatVersion !== 1 || file.algorithmVersion !== PLANNER_ALGORITHM_VERSION) throw new Error("任务格式或算法版本不兼容。");
    if (typeof file.taskId !== "string" || !file.taskId || file.taskId.length > 200) throw new Error("任务编号无效。");
    assertJson(file);
    const { request, checkpoint: point, progress } = file;
    validateTaskRequest(registry, request);
    if (!point || !progress || progress.taskId !== file.taskId) throw new Error("任务缺少检查点或进度。");
    for (const count of [point.attempt, point.evaluations, progress.candidateCount, progress.validatedCandidateCount]) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("任务计数无效。");
    }
    // 旧任务未暴露提案进度；以已持久化检查点恢复累计，旧本轮无记录则归零。
    const evaluatedProposals = progress.evaluatedProposals ?? point.evaluations;
    const roundEvaluatedProposals = progress.roundEvaluatedProposals ?? 0;
    if (evaluatedProposals !== point.evaluations || !Number.isSafeInteger(roundEvaluatedProposals)
      || roundEvaluatedProposals < 0 || roundEvaluatedProposals > evaluatedProposals
      || roundEvaluatedProposals > request.options.evaluationsPerRound) throw new Error("提案计数无效。");
    if (!Number.isFinite(progress.elapsedMs) || progress.elapsedMs < 0 || !Number.isFinite(progress.startedAt)
      || point.attempt !== progress.candidateCount || progress.validatedCandidateCount > point.attempt
      || !["running", "waiting", "saving", "completed", "cancelled", "failed", "save-failed"].includes(progress.status)) throw new Error("任务进度无效。");
    if (!Array.isArray(point.portfolio?.pools) || point.portfolio.pools.length > 2) throw new Error("搜索池无效。");
    const portfolio = new PlannerSearchPortfolio(request);
    portfolio.restore(point.portfolio);
    const seedRequest = (mode: BlueprintPlannerRequest["options"]["solidOutput"]) => request.options.solidOutput === "auto"
      ? { ...request, options: { ...request.options, solidOutput: mode } } : request;
    for (const pool of point.portfolio.pools) for (const entry of pool.entries) {
      validateTaskRequest(registry, entry.seed.network.request);
      restorePlannerSeed(registry, seedRequest(entry.seed.network.request.options.solidOutput), entry.seed);
    }
    for (const candidate of [point.best?.candidate ?? null, point.pendingCandidate]) {
      if (candidate === null) continue;
      if (!candidate?.execution?.blueprint || candidate.execution.blueprint.schemaVersion !== BLUEPRINT_SCHEMA_VERSION
        || !Array.isArray(candidate.execution.blueprint.entityOrder) || !Array.isArray(candidate.connections)
        || !Array.isArray(candidate.supplyAudit?.operatingLimits) || !Number.isSafeInteger(candidate.search?.evaluations)
        || candidate.search.evaluations < 0 || !Number.isFinite(candidate.metrics?.area) || candidate.metrics.area <= 0) throw new Error("候选蓝图无效。");
      for (const id of candidate.execution.blueprint.entityOrder) {
        const entity = candidate.execution.blueprint.entities[id];
        if (!entity || registry.queries.findEntityDefinition(entity.definitionId) === null
          || !Number.isFinite(entity.position.x) || !Number.isFinite(entity.position.y)) throw new Error("候选蓝图包含无效设备。");
      }
      if (candidate.seed) restorePlannerSeed(registry, seedRequest(candidate.seed.network.request.options.solidOutput), candidate.seed);
    }
    if (point.best !== null && (!Array.isArray(point.best.report?.probes) || point.best.report.status !== "completed")) throw new Error("最优结果缺少验证报告。");
    if (point.result !== null && (point.result.taskId !== file.taskId || !point.best
      || point.result.blueprint.blueprintId !== point.best.candidate.execution.blueprint.blueprintId)) throw new Error("结果与检查点不匹配。");
    if (point.savedBlueprintId !== null && typeof point.savedBlueprintId !== "string") throw new Error("保存记录无效。");
    return { ...file, progress: { ...progress, evaluatedProposals, roundEvaluatedProposals } };
  } catch (error) {
    throw new Error(`无法读取计算任务：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateTaskRequest(registry: RegistryContract, request: BlueprintPlannerRequest): void {
  const { plan, options } = request;
  if (typeof plan.name !== "string" || typeof plan.sourceBaseId !== "string" || typeof plan.containsModules !== "boolean") throw new Error("产线信息无效。");
  for (const key of ["solidSupply", "fluidSupply", "warehouseBus", "solidOutput", "byproducts", "plantStartup"] as const) {
    const choices = { solidSupply: ["external", "warehouse"], fluidSupply: ["external", "conduit"], warehouseBus: ["straight", "free"],
      solidOutput: ["auto", "warehouse", "stash"], byproducts: ["destroy", "output"], plantStartup: ["preload", "warehouse"] };
    if (!choices[key].includes(options[key])) throw new Error(`无效的规划选项：${key}`);
  }
  for (const list of [plan.targets, plan.externalSupplies, ...plan.recipes.flatMap(recipe => [recipe.inputs, recipe.outputs, recipe.runningInputs])]) {
    if (!Array.isArray(list) || list.some(flow => typeof flow.itemId !== "string" || !Number.isFinite(flow.perMinute) || flow.perMinute < 0)) throw new Error("产线流量无效。");
  }
  for (const list of [plan.infiniteItemIds, plan.byproductItemIds, plan.activeActivityIds]) {
    if (!Array.isArray(list) || list.some(id => typeof id !== "string")) throw new Error("产线标识无效。");
  }
  validatePlannerRequest(registry, request);
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 100) throw new Error("任务数据嵌套过深。");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("任务包含非有限数值。");
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("任务必须是 JSON 数据。");
    for (const entry of Object.values(value)) assertJson(entry, depth + 1);
  }
}
