// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { PlannerSearchPortfolio } from "@/blueprint-planner/search-portfolio";
import { capturePlannerSeed } from "@/blueprint-planner/search-seed";
import { createProductionNetwork } from "@/blueprint-planner/production-network";
import { emptyPlannerCheckpoint, parsePlannerTaskFile, PLANNER_ALGORITHM_VERSION } from "@/blueprint-planner/task-checkpoint";
import { createBlueprintPlannerHost } from "@/blueprint-planner/blueprint-planner-host";
import { PlannerBatchSession } from "@/scripts/eda/planner-runner";
import yazhen from "./fixtures/yazhen-syringe.json";

function taskFile(): BlueprintPlannerTaskFile {
  return { formatVersion: 1, algorithmVersion: PLANNER_ALGORITHM_VERSION, taskId: "test-task",
    request: structuredClone(yazhen.request) as BlueprintPlannerRequest, checkpoint: emptyPlannerCheckpoint(),
    progress: { taskId: "test-task", status: "waiting", phase: "preparing", startedAt: 1,
      elapsedMs: 0, estimatedProgress: null, evaluatedProposals: 0, roundEvaluatedProposals: 0, candidateCount: 0, validatedCandidateCount: 0, bestArea: null, areaHistory: [], message: null } };
}

it("检查点往返保持布局池的访问次数、轮换顺序和独立输出拓扑", () => {
  const registry = createRegistryContract();
  const request = structuredClone(yazhen.request) as BlueprintPlannerRequest;
  const auto = { ...request, options: { ...request.options, solidOutput: "auto" as const } };
  const pool = new PlannerSearchPortfolio(auto);
  for (const mode of ["stash", "warehouse"] as const) {
    const input = { ...request, options: { ...request.options, solidOutput: mode } };
    const seed = capturePlannerSeed(input, createProductionNetwork(registry, input), [], [], 20, 20);
    pool.remember(seed);
    const other = structuredClone(seed);
    other.network.nodes[0]!.entity.position = { ...other.network.nodes[0]!.entity.position, x: other.network.nodes[0]!.entity.position.x + 1 };
    pool.remember(other);
  }
  for (let i = 0; i < 17; i++) pool.next(i);
  const restored = new PlannerSearchPortfolio(auto);
  restored.restore(JSON.parse(JSON.stringify(pool.snapshot())));
  for (let i = 17; i < 40; i++) expect(restored.next(i)).toEqual(pool.next(i));
});

it("检查点使用原始请求校验归一化网络，不重置已完成的搜索池", () => {
  const registry = createRegistryContract(), file = taskFile();
  const seed = capturePlannerSeed(file.request, createProductionNetwork(registry, file.request), [], [], 20, 20);
  const pool = new PlannerSearchPortfolio(file.request, seed);
  pool.next(0); pool.next(1);
  const checkpoint = { ...emptyPlannerCheckpoint(), portfolio: pool.snapshot() };
  const parsed = parsePlannerTaskFile(JSON.parse(JSON.stringify({ ...file, checkpoint })), registry);
  expect(parsed.checkpoint.portfolio).toEqual(checkpoint.portfolio);
});

it("拒绝不兼容版本、错误计数与无效选项，不能降级为从头计算", () => {
  const registry = createRegistryContract(), file = taskFile();
  expect(parsePlannerTaskFile(JSON.parse(JSON.stringify(file)), registry)).toEqual(file);
  expect(() => parsePlannerTaskFile({ ...file, algorithmVersion: "future" }, registry)).toThrow("版本不兼容");
  expect(() => parsePlannerTaskFile({ ...file, checkpoint: { ...emptyPlannerCheckpoint(), attempt: -1 } }, registry)).toThrow("计数无效");
  expect(() => parsePlannerTaskFile({ ...file, request: { ...file.request, options: { ...file.request.options, solidSupply: "invalid" } } }, registry)).toThrow("规划选项");
});

it("自动任务可以跨机器恢复，活动 Worker 数不会随文件恢复", () => {
  const registry = createRegistryContract(), file = taskFile();
  const input = { ...file, request: { ...file.request, options: { ...file.request.options, concurrency: "auto" as const } },
    progress: { ...file.progress, activeWorkerCount: 3 } };
  const restored = parsePlannerTaskFile(JSON.parse(JSON.stringify(input)), registry);
  expect(restored.request.options.concurrency).toBe("auto");
  expect(restored.progress.activeWorkerCount).toBe(0);
  expect(restored.checkpoint).toEqual(file.checkpoint);
  expect(input.progress.activeWorkerCount).toBe(3);
  expect(() => parsePlannerTaskFile({ ...input, progress: { ...input.progress, activeWorkerCount: -1 } }, registry)).toThrow("并行状态无效");
});

it("真实 Worker 与仿真 Host 支持多任务导入、续算检查点与删除隔离", async () => {
  const session = new PlannerBatchSession();
  const host = createBlueprintPlannerHost(session.workspace, { storage: null, roundLimit: () => 10,
    worker: {
      build: (request, variant, budgetMs, evaluations, signal, update, seed, continuationStep, maximumArea, targetOutline) =>
        session.planner.build(request, variant, budgetMs, { maxEvaluations: evaluations, seed, continuationStep, maximumArea, targetOutline }, update, signal),
      dispose: () => { void session.planner.dispose(); },
    },
  });
  try {
    const first = await host.actions.importTask(taskFile());
    const second = await host.actions.importTask(taskFile());
    expect(first).not.toBe(second);
    host.actions.continuePlanning(first, 10_000);
    expect(() => host.actions.continuePlanning(second, 10_000)).toThrow("已有任务");
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 20));
    const file = parsePlannerTaskFile(JSON.parse(JSON.stringify(host.queries.exportTask(first))), session.workspace.registry);
    expect(file.checkpoint.attempt).toBeGreaterThan(0);
    expect(file.checkpoint.evaluations).toBe(10);
    expect(file.progress.evaluatedProposals).toBe(10);
    expect(file.progress.roundEvaluatedProposals).toBe(10);
    const imported = await host.actions.importTask(file);
    expect(host.queries.getTask(imported)?.candidateCount).toBe(file.progress.candidateCount);
    await host.actions.deleteTask(second);
    expect(host.queries.listTasks().map(task => task.taskId)).toEqual(expect.arrayContaining([first, imported]));
    expect(host.queries.getTask(second)).toBeNull();
    host.actions.continuePlanning(imported, 10_000);
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 20));
    const resumed = parsePlannerTaskFile(host.queries.exportTask(imported), session.workspace.registry);
    expect(resumed.checkpoint.attempt).toBeGreaterThan(file.checkpoint.attempt);
    expect(resumed.checkpoint.evaluations).toBe(20);
    expect(resumed.progress.evaluatedProposals).toBe(20);
    expect(resumed.progress.roundEvaluatedProposals).toBe(10);
    expect(host.queries.getTask(first)?.candidateCount).toBe(file.progress.candidateCount);
  } finally { host.dispose(); await session.dispose(); }
}, 90_000);

it("真实 Worker 暂停结算已用提案，续算只重置本轮计数且不受旧时间预算影响", async () => {
  const session = new PlannerBatchSession();
  let requestedPause = false;
  const host = createBlueprintPlannerHost(session.workspace, { storage: null,
    worker: {
      build: (request, variant, budgetMs, evaluations, signal, update, seed, continuationStep, maximumArea, targetOutline) =>
        session.planner.build(request, variant, budgetMs, { maxEvaluations: evaluations, seed, continuationStep, maximumArea, targetOutline },
          (phase, message, count) => {
            update(phase, message, count);
            if (!requestedPause && count > 0) {
              requestedPause = true;
              host.actions.cancel(host.state.activeTaskId!);
            }
          }, signal),
      dispose: () => { void session.planner.dispose(); },
    },
  });
  try {
    const original = taskFile();
    const file = { ...original, request: { ...original.request,
      options: { ...original.request.options, budgetMs: 1, evaluationsPerRound: 100_000 } } };
    const id = await host.actions.importTask(file);
    host.actions.continuePlanning(id, 100_000);
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 20));
    const paused = parsePlannerTaskFile(host.queries.exportTask(id), session.workspace.registry);
    expect(requestedPause).toBe(true);
    expect(paused.progress.status).toBe("waiting");
    expect(paused.progress.evaluatedProposals).toBeGreaterThan(0);
    expect(paused.progress.evaluatedProposals).toBeLessThan(100_000);
    expect(paused.progress.roundEvaluatedProposals).toBe(paused.checkpoint.evaluations);
    expect(paused.progress.elapsedMs).toBeGreaterThan(1);
    const imported = await host.actions.importTask(JSON.parse(JSON.stringify(paused)));
    expect(host.queries.getTask(imported)?.evaluatedProposals).toBe(paused.checkpoint.evaluations);
    host.actions.continuePlanning(imported, 10_000);
    expect(host.queries.getTask(imported)?.roundEvaluatedProposals).toBe(0);
    expect(host.queries.getTask(imported)?.evaluatedProposals).toBe(paused.checkpoint.evaluations);
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 20));
    const continued = host.queries.getTask(imported)!;
    expect(continued.roundEvaluatedProposals).toBe(10_000);
    expect(continued.evaluatedProposals).toBe(paused.checkpoint.evaluations + 10_000);
  } finally { host.dispose(); await session.dispose(); }
}, 90_000);

it("已知旧算法重置所有搜索状态且保留输入，未知版本与无效输入不猜测迁移", async () => {
  const { restorePlannerTaskFile } = await import("@/blueprint-planner/task-checkpoint");
  const registry = createRegistryContract();
  const file = { ...taskFile(), algorithmVersion: "compact-portfolio-1", checkpoint: { obsolete: true },
    progress: { ...taskFile().progress, elapsedMs: 1234, candidateCount: 12, evaluatedProposals: 100, bestArea: 20 } };
  const original = structuredClone(file);
  const restored = restorePlannerTaskFile(file, registry);
  expect(restored.request).toEqual(file.request);
  expect(restored.taskId).toBe(file.taskId);
  expect(restored.algorithmVersion).toBe(PLANNER_ALGORITHM_VERSION);
  expect(restored.checkpoint).toEqual(emptyPlannerCheckpoint());
  expect(restored.progress).toMatchObject({ status: "waiting", elapsedMs: 0, candidateCount: 0,
    evaluatedProposals: 0, roundEvaluatedProposals: 0, bestArea: null, startedAt: 1 });
  expect(restored.progress.message).toContain("重置");
  expect(file).toEqual(original);
  expect(restorePlannerTaskFile(restored, registry)).toEqual(restored);
  for (const algorithmVersion of ["future", "compact-portfolio-3", "compact-portfolio-0"])
    expect(() => restorePlannerTaskFile({ ...file, algorithmVersion }, registry)).toThrow();
  expect(() => restorePlannerTaskFile({ ...file, request: { ...file.request,
    options: { ...file.request.options, evaluationsPerRound: -1 } } }, registry)).toThrow();
});

it("恢复隔离不兼容记录、保留原文且允许删除；旧算法重置持久化后可重新加载", async () => {
  const session = new PlannerBatchSession();
  const original = { ...taskFile(), taskId: "blocked", algorithmVersion: "future", request: null } as unknown as BlueprintPlannerTaskFile;
  const old = { ...taskFile(), algorithmVersion: "compact-portfolio-1" };
  const records = new Map([[original.taskId, original], [old.taskId, old]]);
  const { hasStorageFailure } = await import("@/shared/storage/storage-failure");
  const before = hasStorageFailure();
  const storage = { load: async () => structuredClone([...records.values()]),
    save: async (file: BlueprintPlannerTaskFile) => { records.set(file.taskId, structuredClone(file)); },
    delete: async (id: string) => { records.delete(id); } };
  const host = createBlueprintPlannerHost(session.workspace, { storage, worker: {
    build: (...args) => session.planner.build(args[0], args[1], args[2], { maxEvaluations: args[3] }, args[5], args[4]),
    dispose: () => {},
  } });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.queries.listTasks()).toHaveLength(2);
    expect(host.queries.getTask("blocked")).toMatchObject({ status: "failed", message: expect.stringContaining("无法继续") });
    expect(host.queries.getLastRequest("blocked")).toBeNull();
    expect(host.queries.exportTask("blocked")).toEqual(original);
    expect(() => host.actions.continuePlanning("blocked", 10_000)).toThrow("无法继续");
    expect(hasStorageFailure()).toBe(before);
    expect(records.get(old.taskId)?.algorithmVersion).toBe(PLANNER_ALGORITHM_VERSION);
    expect(host.queries.getTask(old.taskId)?.message).toContain("重置");
    const imported = await host.actions.importTask(original);
    expect(host.queries.getTask(imported)?.status).toBe("failed");
    expect(host.queries.exportTask(imported)).toEqual({ ...original, taskId: imported });
    await host.actions.deleteTask(imported);
    expect(records.has(imported)).toBe(false);
    host.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(records.get("blocked")).toEqual(original);
  } finally { host.dispose(); await session.dispose(); }
}, 30_000);
