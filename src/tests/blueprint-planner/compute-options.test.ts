// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createBlueprintPlannerHost, type PlannerHostOptions } from "@/blueprint-planner/blueprint-planner-host";
import { PlannerCandidateError } from "@/blueprint-planner/model";
import { plannerRequestKey } from "@/blueprint-planner/search-seed";
import { parsePlannerTaskFile } from "@/blueprint-planner/task-checkpoint";
import { PlannerBatchSession } from "@/scripts/eda/planner-runner";
import fixture from "./fixtures/power-validation.json";

it.each([{ concurrency: 1, gpu: false }, { concurrency: 1, gpu: true },
  { concurrency: "auto", gpu: false }, { concurrency: "auto", gpu: true }] as const)(
  "执行选项独立保存且不改变搜索标识：CPU=$concurrency，GPU=$gpu", async options => {
    const session = new PlannerBatchSession();
    const host = createBlueprintPlannerHost(session.workspace, { storage: null });
    try {
      const request = structuredClone(fixture.request) as BlueprintPlannerRequest;
      const configured = { ...request, options: { ...request.options, ...options } };
      const draft = host.queries.exportDraft(configured);
      const restored = parsePlannerTaskFile(JSON.parse(JSON.stringify(draft)), session.workspace.registry);
      expect(restored.request).toEqual(configured);
      expect(plannerRequestKey(restored.request)).toBe(plannerRequestKey(request));
      const id = await host.actions.importTask(restored);
      expect(host.queries.getLastRequest(id)).toEqual(configured);
      expect(host.queries.exportTask(id).request).toEqual(configured);
    } finally { host.dispose(); await session.dispose(); }
  });

it.each([null, 1, "true"])("任务入口拒绝无效 GPU 开关：%s", async gpu => {
  const session = new PlannerBatchSession();
  const host = createBlueprintPlannerHost(session.workspace, { storage: null });
  try {
    const request = structuredClone(fixture.request) as BlueprintPlannerRequest;
    const file = host.queries.exportDraft(request);
    const invalid = { ...request, options: { ...request.options, gpu } } as unknown as BlueprintPlannerRequest;
    expect(() => parsePlannerTaskFile({ ...file, request: invalid }, session.workspace.registry)).toThrow("GPU");
    expect(() => host.actions.start(invalid)).toThrow("GPU");
    expect(host.state.activeTaskId).toBeNull();
  } finally { host.dispose(); await session.dispose(); }
});

it.each([1, "auto"] as const)("旧任务首次续算保留原 GPU 状态，随后切换互不影响：原 CPU=%s", async originalCpu => {
  const session = new PlannerBatchSession();
  let gpuCreated = 0, gpuDisposed = 0;
  const variants = new Set<number>();
  const worker: NonNullable<PlannerHostOptions["worker"]> = {
    build: async (_request, variant, _ms, budget, _signal, update) => {
      expect(variants.has(variant)).toBe(false); variants.add(variant);
      update("layout", "本批已完成", budget);
      throw new PlannerCandidateError("本批没有候选");
    }, dispose: () => undefined,
  };
  const host = createBlueprintPlannerHost(session.workspace, { storage: null, worker, workerFactory: () => worker,
    resourceHints: { hardwareConcurrency: 8, deviceMemory: 8 }, gpuWorkerFactory: () => {
      gpuCreated++;
      return { ...worker, gpuAvailable: true, dispose: () => { gpuDisposed++; } };
    } });
  let id = "";
  try {
    const request = structuredClone(fixture.request) as BlueprintPlannerRequest;
    id = await host.actions.importTask(host.queries.exportDraft({ ...request, options: { ...request.options, concurrency: originalCpu } }));
    const run = async (concurrency?: number | "auto", gpu?: boolean) => {
      host.actions.continuePlanning(id, 20_000, concurrency, gpu);
      await vi.waitFor(() => expect(host.state.activeTaskId).toBeNull());
      const file = parsePlannerTaskFile(host.queries.exportTask(id), session.workspace.registry);
      expect(file.progress.status).toBe("waiting");
      expect(file.checkpoint.parallel?.count).toBe(32);
      expect(file.checkpoint.parallel?.requestKey).toBe(plannerRequestKey(request));
      return file;
    };
    const legacyGpu = originalCpu === "auto", changedCpu = originalCpu === 1 ? "auto" : 1;
    const first = await run(changedCpu);
    expect(first.request.options).toMatchObject({ concurrency: changedCpu, gpu: legacyGpu });
    expect(gpuCreated).toBe(Number(legacyGpu));
    const disabled = await run(undefined, false);
    expect(disabled.request.options).toMatchObject({ concurrency: changedCpu, gpu: false });
    expect(gpuCreated).toBe(Number(legacyGpu));
    const enabled = await run(1, true);
    expect(enabled.request.options).toMatchObject({ concurrency: 1, gpu: true });
    expect(gpuCreated).toBe(Number(legacyGpu) + 1);
    const automatic = await run("auto");
    expect(automatic.request.options).toMatchObject({ concurrency: "auto", gpu: true });
    expect(gpuCreated).toBe(Number(legacyGpu) + 2);
    expect(gpuDisposed).toBe(gpuCreated);
    expect(automatic.checkpoint.evaluations).toBe(80_000);
    expect(automatic.checkpoint.attempt).toBe(variants.size);
    const beforeInvalid = host.queries.exportTask(id);
    expect(() => host.actions.continuePlanning(id, 20_000, 1, "true" as unknown as boolean)).toThrow("GPU");
    expect(host.queries.exportTask(id)).toEqual(beforeInvalid);
  } finally {
    if (id) host.actions.cancel(id);
    await vi.waitFor(() => expect(host.state.activeTaskId).toBeNull());
    host.dispose(); await session.dispose();
  }
});
