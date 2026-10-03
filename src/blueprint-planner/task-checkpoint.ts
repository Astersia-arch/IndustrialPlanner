import type { BlueprintPlannerRequest, BlueprintPlannerResult, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { SimulationBlueprintRunReport } from "@/domain/simulation";
import { BLUEPRINT_SCHEMA_VERSION } from "@/domain/document/blueprint-document";
import type { PlannerCandidate } from "./candidate";
import { validatePlannerRequest } from "./production-network";
import { PlannerSearchPortfolio, type PlannerPortfolioSnapshot } from "./search-portfolio";
import { plannerRequestKey } from "./search-seed";
import { comparePlannerRanks } from "./quality";
import { restorePlannerSeed } from "./search-seed";

// AI-REMOVED 2026-10-02:
// Reason: 多尺寸批次增加持久化访问记录，旧检查点需要显式迁移。
// Trigger: 用户要求长宽比例广度和多 Worker 避免重复搜索。
// Evidence: compact-portfolio-2 分片仅保存 nextVariant 和局部种子池。
// Replacement: compact-breadth-1 与 restorePlannerTaskFile 迁移；Risk: 旧任务无历史尺寸访问记录；Human Review: Required。
// Original code:
// export const PLANNER_ALGORITHM_VERSION = "compact-portfolio-2";
export const PLANNER_ALGORITHM_VERSION = "compact-breadth-1";

export interface PlannerShardCheckpoint {
  index: number;
  nextVariant: number;
  attempts: number;
  evaluations: number;
  validatedCandidates: number;
  portfolio: PlannerPortfolioSnapshot;
  pendingCandidate: PlannerCandidate | null;
  shapeVisits: Record<string, number>;
}

export interface PlannerParallelCheckpoint {
  count: number;
  originTaskId: string;
  baseAttempt: number;
  baseVariant?: number;
  baseEvaluations: number;
  baseValidatedCandidates: number;
  ownedShards: number[];
  shards: PlannerShardCheckpoint[];
  requestKey: string;
  nextShard: number;
}

export interface PlannerCheckpoint {
  attempt: number;
  evaluations: number;
  portfolio: PlannerPortfolioSnapshot;
  best: { candidate: PlannerCandidate; report: SimulationBlueprintRunReport } | null;
  pendingCandidate: PlannerCandidate | null;
  result: BlueprintPlannerResult | null;
  savedBlueprintId: string | null;
  parallel?: PlannerParallelCheckpoint;
}

export function emptyPlannerCheckpoint(): PlannerCheckpoint {
  return { attempt: 0, evaluations: 0, portfolio: { pools: [] }, best: null, pendingCandidate: null,
    result: null, savedBlueprintId: null };
}

/** 2026-09-30：仅明确支持的旧算法允许保留输入、重置搜索；不猜测未知版本顺序。 */
export function restorePlannerTaskFile(value: BlueprintPlannerTaskFile, registry: RegistryContract): BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint } {
  if (value?.formatVersion === 1 && value.algorithmVersion === "compact-portfolio-2") {
    const file = structuredClone(value) as BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint };
    if (file.checkpoint?.parallel) file.checkpoint.parallel = { ...file.checkpoint.parallel, nextShard: 0,
      shards: file.checkpoint.parallel.shards.map(shard => ({ ...shard, shapeVisits: {} })) };
    return parsePlannerTaskFile({ ...file, algorithmVersion: PLANNER_ALGORITHM_VERSION }, registry);
  }
  if (value?.formatVersion !== 1 || value.algorithmVersion !== "compact-portfolio-1") return parsePlannerTaskFile(value, registry);
  validateTaskRequest(registry, value.request);
  return parsePlannerTaskFile({ ...value, algorithmVersion: PLANNER_ALGORITHM_VERSION,
    checkpoint: emptyPlannerCheckpoint(), progress: { taskId: value.taskId, status: "waiting", phase: "preparing",
      startedAt: value.progress?.startedAt, elapsedMs: 0, estimatedProgress: null, candidateCount: 0,
      evaluatedProposals: 0, roundEvaluatedProposals: 0, validatedCandidateCount: 0, bestArea: null, areaHistory: [],
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
    const history = progress.areaHistory ?? [];
    if (!Array.isArray(history) || history.some((entry, index) => !Number.isSafeInteger(entry.evaluatedProposals)
      || entry.evaluatedProposals < 0 || entry.evaluatedProposals > point.evaluations
      || !Number.isSafeInteger(entry.bestArea) || entry.bestArea <= 0
      || (index > 0 && (entry.evaluatedProposals < history[index - 1]!.evaluatedProposals
        || entry.bestArea >= history[index - 1]!.bestArea)))) throw new Error("面积曲线无效。");
    if (history.length && (point.best === null || history.at(-1)!.bestArea < point.best.candidate.metrics.area)) throw new Error("面积曲线与最优结果不匹配。");
    if (point.parallel) {
      const parallel = point.parallel;
      if (!Number.isSafeInteger(parallel.count) || parallel.count < 1 || parallel.count > 32
        || !Number.isSafeInteger(parallel.nextShard) || parallel.nextShard < 0 || parallel.nextShard >= parallel.count
        || parallel.originTaskId.length < 1 || parallel.requestKey !== plannerRequestKey(request)
        || !Number.isSafeInteger(parallel.baseAttempt) || parallel.baseAttempt < 0
        || (parallel.baseVariant !== undefined && (!Number.isSafeInteger(parallel.baseVariant)
          || parallel.baseVariant < parallel.baseAttempt))
        || !Number.isSafeInteger(parallel.baseEvaluations) || parallel.baseEvaluations < 0
        || !Number.isSafeInteger(parallel.baseValidatedCandidates) || parallel.baseValidatedCandidates < 0
        || !Array.isArray(parallel.shards) || parallel.shards.length !== parallel.count
        || !Array.isArray(parallel.ownedShards) || parallel.ownedShards.length < 1
        || parallel.ownedShards.some(index => !Number.isSafeInteger(index) || index < 0 || index >= parallel.count)
        || new Set(parallel.ownedShards).size !== parallel.ownedShards.length
        || parallel.shards.some((shard, index) => shard.index !== index
          || !Number.isSafeInteger(shard.nextVariant) || shard.nextVariant < (parallel.baseVariant ?? parallel.baseAttempt) + index
          || (shard.nextVariant - (parallel.baseVariant ?? parallel.baseAttempt) - index) % parallel.count !== 0
          || !Number.isSafeInteger(shard.attempts) || shard.attempts < 0
          || shard.nextVariant !== (parallel.baseVariant ?? parallel.baseAttempt) + index + shard.attempts * parallel.count
          || !Number.isSafeInteger(shard.evaluations) || shard.evaluations < 0
          || !Number.isSafeInteger(shard.validatedCandidates) || shard.validatedCandidates < 0
          || shard.validatedCandidates > shard.attempts
          || !shard.shapeVisits || typeof shard.shapeVisits !== "object" || Array.isArray(shard.shapeVisits)
          || Object.entries(shard.shapeVisits).some(([key, visits]) => !/^(stash|warehouse)\/\d+\/\d+$/.test(key)
            || !Number.isSafeInteger(visits) || visits < 0)
          || Object.values(shard.shapeVisits).reduce((sum, visits) => sum + visits, 0) > shard.attempts
          || !Array.isArray(shard.portfolio?.pools))) throw new Error("分片检查点无效。");
      if (point.attempt !== parallel.baseAttempt + parallel.shards.reduce((sum, shard) => sum + shard.attempts, 0)
        || point.evaluations !== parallel.baseEvaluations + parallel.shards.reduce((sum, shard) => sum + shard.evaluations, 0)
        || progress.validatedCandidateCount !== parallel.baseValidatedCandidates
          + parallel.shards.reduce((sum, shard) => sum + shard.validatedCandidates, 0)
        || point.pendingCandidate !== null) throw new Error("分片汇总计数无效。");
      for (const shard of parallel.shards) {
        const pool = new PlannerSearchPortfolio(request);
        pool.restore(shard.portfolio);
        if (shard.pendingCandidate !== null && (!shard.pendingCandidate.execution?.blueprint
          || !Number.isSafeInteger(shard.pendingCandidate.search?.evaluations))) throw new Error("分片候选无效。");
      }
    }
    return { ...file, progress: { ...progress, evaluatedProposals, roundEvaluatedProposals, areaHistory: history } };
  } catch (error) {
    throw new Error(`无法读取计算任务：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateTaskRequest(registry: RegistryContract, request: BlueprintPlannerRequest): void {
  const { plan, options } = request;
  if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency)
    || options.concurrency < 1 || options.concurrency > 32)) throw new Error("并发计算数必须介于 1 到 32。");
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

/** 独立分片的已提交检查点合并；跨机器没有可信的全局事件时钟，只记录合并时的准确总计数。 */
export function mergePlannerTaskFiles(values: readonly BlueprintPlannerTaskFile[], registry: RegistryContract): BlueprintPlannerTaskFile {
  if (values.length < 1) throw new Error("至少提供一个分片任务。");
  const files = values.map(value => restorePlannerTaskFile(value, registry));
  const first = files[0]!;
  const base = first.checkpoint.parallel;
  if (!base) throw new Error("任务没有分片检查点。");
  const selected = new Map<number, PlannerShardCheckpoint>();
  for (const file of files) {
    const parallel = file.checkpoint.parallel;
    if (!parallel || parallel.count !== base.count || parallel.originTaskId !== base.originTaskId
      || parallel.requestKey !== base.requestKey || parallel.baseAttempt !== base.baseAttempt
      || parallel.baseVariant !== base.baseVariant
      || parallel.baseEvaluations !== base.baseEvaluations
      || parallel.baseValidatedCandidates !== base.baseValidatedCandidates) throw new Error("分片任务不是同一计算起点。");
    for (const index of parallel.ownedShards) {
      if (selected.has(index)) throw new Error(`分片 ${index} 重复，不能合并。`);
      selected.set(index, structuredClone(parallel.shards[index]!));
    }
  }
  if (selected.size !== base.count) throw new Error(`分片不完整：已收到 ${selected.size}/${base.count}。`);
  const shards = Array.from({ length: base.count }, (_, index) => selected.get(index)!);
  const attempt = base.baseAttempt + shards.reduce((sum, shard) => sum + shard.attempts, 0);
  const evaluations = base.baseEvaluations + shards.reduce((sum, shard) => sum + shard.evaluations, 0);
  const ranked = files.filter(file => file.checkpoint.best !== null).sort((a, b) => {
    const candidateA = a.checkpoint.best!.candidate, candidateB = b.checkpoint.best!.candidate;
    return comparePlannerRanks({ area: candidateA.metrics.area,
      outputStashCount: candidateA.search.quality?.outputStashCount,
      secondary: candidateA.search.quality?.secondary ?? candidateA.metrics.score },
    { area: candidateB.metrics.area, outputStashCount: candidateB.search.quality?.outputStashCount,
      secondary: candidateB.search.quality?.secondary ?? candidateB.metrics.score });
  });
  const winner = ranked[0];
  const best = winner?.checkpoint.best ?? null;
  const result = winner?.checkpoint.result ?? null;
  const taskId = base.originTaskId;
  const merged: BlueprintPlannerTaskFile = {
    ...first, taskId,
    checkpoint: { ...first.checkpoint, attempt, evaluations, best,
      result: result ? { ...result, taskId, folderId: null } : null,
      savedBlueprintId: null, pendingCandidate: null,
      parallel: { ...base, ownedShards: shards.map(shard => shard.index), shards } } satisfies PlannerCheckpoint,
    progress: { ...first.progress, taskId, status: "waiting", estimatedProgress: null,
      elapsedMs: Math.max(...files.map(file => file.progress.elapsedMs)),
      evaluatedProposals: evaluations, roundEvaluatedProposals: 0, candidateCount: attempt,
      validatedCandidateCount: base.baseValidatedCandidates + shards.reduce((sum, shard) => sum + shard.validatedCandidates, 0),
      bestArea: best?.candidate.metrics.area ?? null,
      areaHistory: best ? [{ evaluatedProposals: evaluations, bestArea: best.candidate.metrics.area }] : [],
      message: "分片结果已合并，可以继续计算或保存蓝图。" },
  };
  return parsePlannerTaskFile(merged, registry);
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 100) throw new Error("任务数据嵌套过深。");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("任务包含非有限数值。");
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("任务必须是 JSON 数据。");
    for (const entry of Object.values(value)) assertJson(entry, depth + 1);
  }
}
