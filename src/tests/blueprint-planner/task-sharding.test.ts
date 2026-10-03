// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import { createBlueprintPlannerHost, type PlannerHostOptions } from "@/blueprint-planner/blueprint-planner-host";
import { PlannerCandidateError } from "@/blueprint-planner/model";
import { emptyPlannerCheckpoint, mergePlannerTaskFiles, parsePlannerTaskFile, restorePlannerTaskFile, PLANNER_ALGORITHM_VERSION,
  type PlannerCheckpoint } from "@/blueprint-planner/task-checkpoint";
import { PlannerBatchSession } from "@/scripts/eda/planner-runner";
import { NodePlannerClient } from "@/scripts/eda/node-planner-client";
import yazhen from "./fixtures/yazhen-syringe.json";

function originalTask(concurrency = 1): BlueprintPlannerTaskFile {
  const request = structuredClone(yazhen.request) as BlueprintPlannerRequest;
  return { formatVersion: 1, algorithmVersion: PLANNER_ALGORITHM_VERSION, taskId: "collaboration-origin",
    request: { ...request, options: { ...request.options, concurrency } }, checkpoint: emptyPlannerCheckpoint(),
    progress: { taskId: "collaboration-origin", status: "waiting", phase: "preparing", startedAt: 1,
      elapsedMs: 0, estimatedProgress: null, evaluatedProposals: 0, roundEvaluatedProposals: 0,
      candidateCount: 0, validatedCandidateCount: 0, bestArea: null, areaHistory: [], message: null } };
}

async function runRange(start: number, end: number, count: number, input: BlueprintPlannerTaskFile) {
  const session = new PlannerBatchSession();
  const clients: NodePlannerClient[] = [];
  let active = 0, maximumActive = 0;
  const makeWorker: NonNullable<PlannerHostOptions["workerFactory"]> = () => {
    const client = new NodePlannerClient();
    clients.push(client);
    return { build: async (request, variant, budgetMs, evaluations, signal, update, seed, continuationStep, maximumArea, targetOutline) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try { return await client.build(request, variant, budgetMs,
        { maxEvaluations: evaluations, seed, continuationStep, maximumArea, targetOutline }, update, signal); }
      finally { active--; }
    }, dispose: () => { void client.dispose(); } };
  };
  const host = createBlueprintPlannerHost(session.workspace, { storage: null, roundLimit: () => 40,
    worker: makeWorker(), workerFactory: makeWorker, shardSelection: { count, start, end } });
  try {
    const id = await host.actions.importTask(input);
    host.actions.continuePlanning(id, 10_000);
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 20));
    const file = parsePlannerTaskFile(host.queries.exportTask(id), session.workspace.registry);
    expect(file.progress.status, file.progress.message ?? undefined).toBe("waiting");
    return { file, maximumActive, clientCount: clients.length, registry: session.workspace.registry };
  } finally {
    host.dispose();
    await Promise.all(clients.map(client => client.dispose()));
    await session.dispose();
  }
}

it("真实 Node Worker 在分片内执行有界批次，并保存可恢复计数", async () => {
  const { file, maximumActive, clientCount } = await runRange(0, 2, 2, originalTask(2));
  const point = file.checkpoint;
  expect(maximumActive).toBe(1);
  expect(clientCount).toBe(1);
  expect(point.parallel?.shards.map(shard => shard.index)).toEqual([0, 1]);
  expect(point.parallel?.shards.some(shard => shard.attempts > 0)).toBe(true);
  expect(point.evaluations).toBe(40);
  expect(file.progress.evaluatedProposals).toBe(point.evaluations);
}, 90_000);

it("独立分片能从同一旧任务出发并合并，重叠和缺失均拒绝", async () => {
  const input = originalTask();
  const first = await runRange(0, 1, 2, input);
  const second = await runRange(1, 2, 2, input);
  const merged = parsePlannerTaskFile(mergePlannerTaskFiles([first.file, second.file], first.registry), first.registry);
  expect(merged.checkpoint.parallel?.originTaskId).toBe(input.taskId);
  expect(merged.checkpoint.parallel?.ownedShards).toEqual([0, 1]);
  expect(merged.checkpoint.attempt).toBe(first.file.checkpoint.attempt + second.file.checkpoint.attempt);
  expect(merged.checkpoint.evaluations).toBe(first.file.checkpoint.evaluations + second.file.checkpoint.evaluations);
  expect(() => mergePlannerTaskFiles([first.file, first.file], first.registry)).toThrow("重复");
  expect(() => mergePlannerTaskFiles([first.file], first.registry)).toThrow("不完整");
}, 90_000);

it("已运行的并行任务继续分给多人后合并，不重复累计原有验证数", async () => {
  const initial = await runRange(0, 2, 2, originalTask(2));
  const first = await runRange(0, 1, 2, initial.file);
  const second = await runRange(1, 2, 2, initial.file);
  const merged = parsePlannerTaskFile(mergePlannerTaskFiles([first.file, second.file], first.registry), first.registry);
  const oldValidated = initial.file.progress.validatedCandidateCount;
  expect(merged.progress.validatedCandidateCount).toBe(oldValidated
    + (first.file.progress.validatedCandidateCount - oldValidated)
    + (second.file.progress.validatedCandidateCount - oldValidated));
  expect(merged.checkpoint.evaluations).toBe(first.file.checkpoint.evaluations
    + second.file.checkpoint.evaluations - initial.file.checkpoint.evaluations);
}, 90_000);

it("较小总分片数转换到浏览器虚拟分片后，保留累计进度并重建尺寸访问记录", async () => {
  const previous = (await runRange(0, 2, 2, originalTask(2))).file;
  const counted = previous.checkpoint.parallel!.shards.find(shard => shard.attempts > 0)!;
  counted.shapeVisits["stash/999/999"] = 1;
  const session = new PlannerBatchSession();
  const host = createBlueprintPlannerHost(session.workspace, { storage: null, roundLimit: () => 10,
    worker: { build: async (_request, _variant, _budgetMs, _evaluations, _signal, update) => {
      update("layout", "搜索中", 10);
      throw new PlannerCandidateError("本次布局无候选");
    }, dispose: () => undefined } });
  try {
    const id = await host.actions.importTask(previous);
    host.actions.continuePlanning(id, 10_000);
    while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 5));
    const resumed = parsePlannerTaskFile(host.queries.exportTask(id), session.workspace.registry);
    expect(resumed.checkpoint.parallel?.count).toBe(32);
    expect(resumed.checkpoint.evaluations).toBe(previous.checkpoint.evaluations + 10);
    expect(resumed.checkpoint.parallel?.shards.every(shard => shard.shapeVisits["stash/999/999"] === undefined)).toBe(true);
  } finally { host.dispose(); await session.dispose(); }
}, 90_000);

it("暂停后调整提案预算与并发数，保留检查点且不重复搜索序号", async () => {
  const session = new PlannerBatchSession();
  let active = 0, maximumActive = 0;
  const variants: number[] = [];
  const makeWorker: NonNullable<PlannerHostOptions["workerFactory"]> = () => ({
    build: async (_request, variant, _budgetMs, _evaluations, _signal, update) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      variants.push(variant);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        update("layout", "搜索中", 20_000);
        throw new PlannerCandidateError("本次布局无候选");
      } finally { active--; }
    },
    dispose: () => undefined,
  });
  const host = createBlueprintPlannerHost(session.workspace, { storage: null, roundLimit: () => 80_000,
    worker: makeWorker(), workerFactory: makeWorker });
  try {
    const id = await host.actions.importTask(originalTask(2));
    const run = async (proposals: number, concurrency?: number) => {
      maximumActive = 0;
      host.actions.continuePlanning(id, proposals, concurrency);
      while (host.state.activeTaskId !== null) await new Promise(resolve => setTimeout(resolve, 5));
      const exported = host.queries.exportTask(id);
      expect(exported.progress.evaluatedProposals).toBe((exported.checkpoint as PlannerCheckpoint).evaluations);
      expect(exported.progress.roundEvaluatedProposals).toBeLessThanOrEqual(exported.request.options.evaluationsPerRound);
      return parsePlannerTaskFile(exported, session.workspace.registry);
    };
    const first = await run(100_000);
    expect(maximumActive).toBe(2);
    expect(first.checkpoint.parallel?.count).toBe(32);
    const legacy = structuredClone({ ...first, algorithmVersion: "compact-portfolio-2" });
    Reflect.deleteProperty(legacy.checkpoint.parallel!, "nextShard");
    for (const shard of legacy.checkpoint.parallel!.shards) Reflect.deleteProperty(shard, "shapeVisits");
    const migrated = restorePlannerTaskFile(legacy, session.workspace.registry);
    expect(migrated.checkpoint.evaluations).toBe(first.checkpoint.evaluations);
    expect(migrated.checkpoint.parallel?.shards.every(shard => Object.keys(shard.shapeVisits).length === 0)).toBe(true);

    const decreased = await run(200_000, 1);
    expect(maximumActive).toBe(1);
    expect(decreased.checkpoint.parallel?.count).toBe(32);
    expect(decreased.request.options).toMatchObject({ evaluationsPerRound: 200_000, concurrency: 1 });

    const increased = await run(300_000, 4);
    expect(maximumActive).toBe(4);
    expect(increased.checkpoint.parallel?.count).toBe(32);
    expect(increased.request.options).toMatchObject({ evaluationsPerRound: 300_000, concurrency: 4 });
    expect(increased.checkpoint.evaluations).toBe(240_000);
    expect(increased.progress.roundEvaluatedProposals).toBe(80_000);
    expect(new Set(variants).size).toBe(variants.length);
    expect(() => host.actions.continuePlanning(id, 10_000, 33)).toThrow("并发计算数");
    expect(host.queries.getLastRequest(id)?.options.concurrency).toBe(4);
  } finally {
    host.dispose();
    await session.dispose();
  }
}, 90_000);
