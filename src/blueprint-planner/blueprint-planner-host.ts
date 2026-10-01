import { observable, runInAction } from "mobx";
import type { WorkspaceContract } from "@/domain/document/workspace-contract";
import type { BlueprintPlannerContract, BlueprintPlannerProgress, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import { createUuid } from "@/domain/shared/uuid";
    // AI-REMOVED 2026-09-30: 浏览器蓝图库只在保存时加载，避免无头入口依赖浏览器环境。
    // Trigger: Node 客户端启动。Evidence: 同步存储依赖 import.meta.env。
    // Replacement: save 内动态 import。Risk: Low。Human Review: Required
    // Original code:
    // import { createBlueprintFolder, listBlueprintDirectory, saveBlueprintDocument } from "@/shared/storage/blueprint-storage";
import { edaTaskStorage } from "@/shared/storage/eda-task-storage";
import { reportStorageFailure } from "@/shared/storage/storage-failure";
import { PlannerWorkerClient } from "./worker-client";
import { PlannerCandidateError, PlanningBudgetExhausted } from "./model";
import { comparePlannerRanks } from "./quality";
import { meetsOperatingLimits, meetsProductionTargets } from "./verification";
import { PlannerSearchPortfolio } from "./search-portfolio";
import { emptyPlannerCheckpoint, restorePlannerTaskFile, PLANNER_ALGORITHM_VERSION, validateTaskRequest, type PlannerCheckpoint } from "./task-checkpoint";

interface PlannerTask {
  file: BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint };
  portfolio: PlannerSearchPortfolio;
  abort: AbortController;
  resumedAt: number | null;
  roundStartedEvaluations: number;
  remaining: number;
  running: Promise<void> | null;
}

export interface BlueprintPlannerHost extends BlueprintPlannerContract { dispose(): void; }

/** 浏览器与无头客户端只替换 IO，任务状态机、检查点与验收共用。 */
export interface PlannerHostOptions {
  readonly worker?: Pick<PlannerWorkerClient, "build" | "dispose">;
  readonly storage?: typeof edaTaskStorage | null;
  readonly roundLimit?: () => number;
}

export function createBlueprintPlannerHost(workspace: WorkspaceContract, options: PlannerHostOptions = {}): BlueprintPlannerHost {
  const state = observable<{ activeTaskId: string | null; revision: number }>({ activeTaskId: null, revision: 0 });
  const tasks = new Map<string, PlannerTask>();
  // 无法恢复的记录独立保留原文，禁止生命周期自动保存覆盖它们。
  const blockedTasks = new Map<string, { file: BlueprintPlannerTaskFile; progress: BlueprintPlannerProgress }>();
  const retainBlocked = (file: BlueprintPlannerTaskFile, error: unknown) => {
    const id = file.taskId;
    blockedTasks.set(id, { file: structuredClone(file), progress: { taskId: id, status: "failed", phase: "preparing",
      startedAt: Number.isFinite(file.progress?.startedAt) ? file.progress.startedAt : 0,
      elapsedMs: 0, estimatedProgress: null, candidateCount: 0, evaluatedProposals: 0,
      roundEvaluatedProposals: 0, validatedCandidateCount: 0, bestArea: null,
      message: `任务无法继续，原始记录已保留，可导出或删除。${errorMessage(error)}` } });
  };
  const worker = options.worker ?? new PlannerWorkerClient();
  const storage = options.storage === undefined ? edaTaskStorage : options.storage;
  let disposed = false, loaded = storage === null;
  let latestId: string | undefined;
  let writes: Promise<void> = Promise.resolve();
  const notify = () => runInAction(() => { state.revision++; });
  const elapsed = (task: PlannerTask) => task.file.progress.elapsedMs + (task.resumedAt === null ? 0 : performance.now() - task.resumedAt);
  const snapshot = (task: PlannerTask): BlueprintPlannerTaskFile => structuredClone({ ...task.file,
    progress: { ...task.file.progress, elapsedMs: elapsed(task) },
    checkpoint: { ...task.file.checkpoint, portfolio: task.portfolio.snapshot() } });
  const persist = (task: PlannerTask) => {
    if (storage === null) return;
    const file = snapshot(task);
    writes = writes.then(() => storage.save(file)).catch(error => reportStorageFailure("eda-task", error));
  };
  const publish = (task: PlannerTask, patch: Partial<BlueprintPlannerProgress>) => {
    const spent = elapsed(task);
    if (task.resumedAt !== null) task.resumedAt = performance.now();
    task.file = { ...task.file, progress: { ...task.file.progress, ...patch, elapsedMs: spent } };
    notify();
  };
  const assertReady = () => {
    if (disposed) throw new Error("规划器已关闭。");
    if (!loaded) throw new Error("正在读取历史计算任务，请稍候。");
  };
  const requireTask = (id: string) => {
    assertReady();
    const blocked = blockedTasks.get(id);
    if (blocked) throw new Error(blocked.progress.message!);
    const task = tasks.get(id);
    if (!task) throw new Error("计算任务不存在。");
    return task;
  };
  const materialize = (file: BlueprintPlannerTaskFile): PlannerTask => {
    const parsed = restorePlannerTaskFile(file, workspace.registry);
    const portfolio = new PlannerSearchPortfolio(parsed.request);
    portfolio.restore(parsed.checkpoint.portfolio);
    return { file: parsed, portfolio, abort: new AbortController(), resumedAt: null, roundStartedEvaluations: parsed.checkpoint.evaluations - parsed.progress.roundEvaluatedProposals, remaining: 0, running: null };
  };
  const settle = (task: PlannerTask) => {
    publish(task, { estimatedProgress: null });
    task.resumedAt = null;
    task.running = null;
    if (state.activeTaskId === task.file.taskId) runInAction(() => { state.activeTaskId = null; });
    persist(task);
    notify();
  };
  const check = (task: PlannerTask) => {
    if (disposed || task.abort.signal.aborted) throw new DOMException("计算已暂停", "AbortError");
    // AI-REMOVED 2026-09-30:
    // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
    // Trigger: 用户批准本轮接口与交互调整。
    // Evidence: 原实现使用时间截止或关闭任务面板。
    // Replacement: src/blueprint-planner/blueprint-planner-host.ts
    // Risk: Low。Human Review: Required
    // Original code:
    //     if (performance.now() >= task.deadline) throw new PlanningBudgetExhausted();

  };

  async function run(task: PlannerTask): Promise<void> {
    const point = task.file.checkpoint;
    const idleStatus = () => point.result !== null && point.savedBlueprintId === point.result.blueprint.blueprintId ? "completed" as const : "waiting" as const;
    let lastFailure = "尚未找到通过验证的布局";
    try {
      while (task.remaining > 0 || point.pendingCandidate !== null) {
        check(task);
        const allowance = task.remaining;
        let accounted = point.pendingCandidate !== null;
        let observed = 0;
        const account = (count: number) => {
          if (!Number.isSafeInteger(count) || count < observed || count > allowance) throw new Error("Worker 提案计数无效。");
          const delta = count - observed;
          point.evaluations += delta; task.remaining -= delta; observed = count;
          const round = point.evaluations - task.roundStartedEvaluations;
          publish(task, { evaluatedProposals: point.evaluations, roundEvaluatedProposals: round,
            estimatedProgress: Math.min(1, round / task.file.request.options.evaluationsPerRound) });
        };
        try {
          if (point.pendingCandidate === null) {
            const attempt = point.attempt++;
            const selection = task.portfolio.next(attempt);
            publish(task, { candidateCount: point.attempt, message: `正在搜索第 ${point.attempt} 个布局` });
            point.pendingCandidate = await worker.build(selection.request, selection.variant,
              null, allowance, task.abort.signal,
              (phase, message, evaluations) => { account(evaluations); publish(task, { phase, message }); },
              selection.seed, selection.continuationStep, selection.maximumArea);
            const used = point.pendingCandidate.search.evaluations;
            account(used);
            accounted = true;
            persist(task);
          }
          check(task);
          const candidate = point.pendingCandidate;
          const simulation = workspace.simulation;
          if (simulation === null) throw new Error("仿真服务不可用。");
          publish(task, { phase: "verification", message: "正在验证产量与循环运行" });
          const report = await simulation.actions.runBlueprint(candidate.execution, task.abort.signal);
          if (task.abort.signal.aborted) break;
          if (report.status === "timeout") { lastFailure = "产量验证超时，检查点已保留"; break; }
          point.pendingCandidate = null;
          if (!meetsProductionTargets(task.file.request, report) || !meetsOperatingLimits(candidate.supplyAudit, report)) {
            lastFailure = report.diagnostics.find(entry => entry.severity === "error")?.message ?? "布局实际产量未达到目标";
            persist(task);
            continue;
          }
          task.portfolio.remember(candidate.seed);
          publish(task, { validatedCandidateCount: task.file.progress.validatedCandidateCount + 1, phase: "optimization" });
          // AI-REMOVED 2026-09-30:
          // Reason: 同面积优先减少输出箱，不能直接跳到物流成本。Trigger: 多线合箱需求。
          // Evidence: 原选优不区分箱数。Replacement: comparePlannerRanks。
          // Risk: 同面积结果可能改变。Human Review: Required。
          // Original code:
          // if (point.best === null || candidate.metrics.area < point.best.candidate.metrics.area
          //   || (candidate.metrics.area === point.best.candidate.metrics.area
          //     && (candidate.search.quality?.secondary ?? candidate.metrics.score)
          //       < (point.best.candidate.search.quality?.secondary ?? point.best.candidate.metrics.score))) {
          if (point.best === null || comparePlannerRanks({ area: candidate.metrics.area,
            outputStashCount: candidate.search.quality?.outputStashCount, secondary: candidate.search.quality?.secondary ?? candidate.metrics.score },
          { area: point.best.candidate.metrics.area, outputStashCount: point.best.candidate.search.quality?.outputStashCount,
            secondary: point.best.candidate.search.quality?.secondary ?? point.best.candidate.metrics.score }) < 0) {
            point.best = { candidate, report };
            point.result = { taskId: task.file.taskId, blueprint: candidate.execution.blueprint, folderId: null,
              metrics: candidate.metrics, connections: candidate.connections,
              measuredOutputs: report.probes.filter(probe => task.file.request.plan.targets.some(target => target.itemId === probe.id))
                .map(probe => ({ itemId: probe.id, perMinute: probe.perMinute })),
              warmupSeconds: candidate.execution.warmupSeconds, observationSeconds: report.observationSeconds, elapsedMs: elapsed(task) };
            publish(task, { bestArea: candidate.metrics.area });
          }
          persist(task);
        } catch (error) {
          if (!accounted) {
            const used = error instanceof PlannerCandidateError ? error.search?.evaluations ?? observed : observed;
            account(used);
            if (used === 0 && error instanceof PlannerCandidateError) throw new Error(`当前布局无法启动搜索：${error.message}`);
          }
          if (!(error instanceof PlannerCandidateError)) throw error;
          lastFailure = error.message;
          persist(task);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      publish(task, { status: idleStatus(), message: task.abort.signal.aborted ? "计算已暂停，可以继续。"
        : point.best ? "本轮计算完成，可以预览、保存蓝图或继续计算。" : `本轮计算结束；${lastFailure}。可以继续计算。` });
    } catch (error) {
      publish(task, { status: task.abort.signal.aborted || error instanceof PlanningBudgetExhausted ? idleStatus() : "failed",
        message: task.abort.signal.aborted ? "计算已暂停，可以继续。" : error instanceof PlanningBudgetExhausted
          ? "计算中断，检查点已保留，可以继续计算。" : errorMessage(error) });
    } finally { settle(task); }
  }

  function launch(task: PlannerTask, evaluations: number): void {
    if (state.activeTaskId !== null) throw new Error("已有任务正在计算或保存。");
    // AI-REMOVED 2026-09-30:
    // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
    // Trigger: 用户批准本轮接口与交互调整。
    // Evidence: 原实现使用时间截止或关闭任务面板。
    // Replacement: src/blueprint-planner/blueprint-planner-host.ts
    // Risk: Low。Human Review: Required
    // Original code:
    //     if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("计算时间必须大于零。");

    if (!Number.isSafeInteger(evaluations) || evaluations < 10_000 || evaluations % 10_000 !== 0) throw new Error("提案次数必须为不少于一万的整万数。");
    if (workspace.simulation === null) throw new Error("仿真服务不可用。");
    task.file = { ...task.file, request: { ...task.file.request, options: { ...task.file.request.options, evaluationsPerRound: evaluations } } };
    task.abort = new AbortController();
    task.roundStartedEvaluations = task.file.checkpoint.evaluations;
    task.remaining = Math.min(evaluations, options.roundLimit?.() ?? evaluations);
    if (!Number.isSafeInteger(task.remaining) || task.remaining <= 0) throw new Error("剩余提案次数无效。");
    task.resumedAt = performance.now();
    workspace.simulation.actions.stop();
    latestId = task.file.taskId;
    runInAction(() => { state.activeTaskId = task.file.taskId; });
    publish(task, { status: "running", message: "正在计算", estimatedProgress: 0,
      evaluatedProposals: task.file.checkpoint.evaluations, roundEvaluatedProposals: 0 });
    persist(task);
    task.running = Promise.resolve().then(() => run(task));
  }

  async function save(task: PlannerTask): Promise<void> {
    if (state.activeTaskId !== null || task.running !== null) throw new Error("请等待当前计算或保存结束。");
    const result = task.file.checkpoint.result;
    if (result === null || result.blueprint.blueprintId === task.file.checkpoint.savedBlueprintId) throw new Error("当前没有可保存的新结果。");
    runInAction(() => { state.activeTaskId = task.file.taskId; });
    publish(task, { status: "saving", phase: "saving", message: "正在保存蓝图" });
    try {
      const { createBlueprintFolder, listBlueprintDirectory, saveBlueprintDocument } = await import("@/shared/storage/blueprint-storage");
      const directory = await listBlueprintDirectory();
      const folder = directory.folders.find(entry => entry.name === "自动规划") ?? await createBlueprintFolder({ name: "自动规划" });
      if (folder === null) throw new Error("无法创建自动规划文件夹。");
      const saved = await saveBlueprintDocument(result.blueprint, { parentFolderId: folder.folderId });
      if (saved === null) throw new Error("蓝图保存失败，请重试。");
      task.file.checkpoint.result = { ...result, folderId: folder.folderId };
      task.file.checkpoint.savedBlueprintId = result.blueprint.blueprintId;
      publish(task, { status: "completed", message: "蓝图已保存到用户蓝图/自动规划" });
    } catch (error) {
      publish(task, { status: "save-failed", message: errorMessage(error) });
      throw error;
    } finally { settle(task); }
  }

  const ready = storage === null ? Promise.resolve() : storage.load().then(files => {
    if (disposed) return;
    for (const file of files) {
      try {
        const task = materialize(file);
        if (["running", "saving"].includes(task.file.progress.status)) task.file = { ...task.file,
          progress: { ...task.file.progress, status: "waiting", message: "计算已恢复，可以继续。", estimatedProgress: null } };
        tasks.set(file.taskId, task);
        latestId = file.taskId;
        if (file.algorithmVersion !== task.file.algorithmVersion) persist(task);
      // AI-REMOVED 2026-09-30:
      // Reason: 任务不兼容不是数据库故障。Trigger: 旧算法任务触发全局红条。
      // Evidence: eda-task-restore 日志。Replacement: retainBlocked。
      // Risk: Low。Human Review: Required
      // Original code:
      // } catch (error) { reportStorageFailure("eda-task-restore", error); }
      } catch (error) { retainBlocked(file, error); latestId = file.taskId; }
    }
  }).catch(error => reportStorageFailure("eda-task-load", error)).finally(() => { loaded = true; notify(); });

  const host: BlueprintPlannerHost = {
    state,
    actions: {
      start(request) {
        assertReady();
        validateTaskRequest(workspace.registry, request);
        if (state.activeTaskId !== null) throw new Error("已有任务正在计算。");
        const id = createUuid();
        const task = materialize({ formatVersion: 1, algorithmVersion: PLANNER_ALGORITHM_VERSION, taskId: id,
          request: structuredClone(request), checkpoint: emptyPlannerCheckpoint(), progress: { taskId: id, status: "waiting",
            phase: "preparing", startedAt: Date.now(), elapsedMs: 0, estimatedProgress: null, candidateCount: 0,
            evaluatedProposals: 0, roundEvaluatedProposals: 0,
            validatedCandidateCount: 0, bestArea: null, message: null } });
        tasks.set(id, task);
        launch(task, request.options.evaluationsPerRound);
        return id;
      },
      continuePlanning(id, evaluations) {
        const task = requireTask(id);
        launch(task, evaluations);
      },
      cancel(id) {
        const task = requireTask(id);
        if (task.file.progress.status === "running") task.abort.abort();
      },
      save: id => save(requireTask(id)),
      retrySave: id => save(requireTask(id)),
      async deleteTask(id) {
        assertReady();
        const task = blockedTasks.has(id) ? null : requireTask(id);
        if (state.activeTaskId === id || task?.running != null) throw new Error("请先暂停任务并等待计算结束。");
        await writes;
        await storage?.delete(id);
        tasks.delete(id);
        blockedTasks.delete(id);
        notify();
      },
      async importTask(file) {
        await ready;
        assertReady();
        let task: PlannerTask;
        try { task = materialize(file); } catch (error) {
          if (!file || typeof file !== "object" || typeof file.taskId !== "string" || !file.taskId) throw error;
          const id = createUuid();
          const retained = { ...structuredClone(file), taskId: id };
          await storage?.save(retained);
          retainBlocked(retained, error);
          latestId = id;
          notify();
          return id;
        }
        // 导入始终创建独立任务，不能覆盖正在计算的同名任务或本机历史。
        const id = createUuid();
        task.file = { ...task.file, taskId: id, progress: { ...task.file.progress, taskId: id, status: "waiting",
          message: file.algorithmVersion === task.file.algorithmVersion ? "任务已导入，可以继续计算。" : task.file.progress.message, estimatedProgress: null } };
        const result = task.file.checkpoint.result;
        const blueprint = task.file.checkpoint.best?.candidate.execution.blueprint;
        if (blueprint) blueprint.blueprintId = createUuid();
        const pendingBlueprint = task.file.checkpoint.pendingCandidate?.execution.blueprint;
        if (pendingBlueprint && pendingBlueprint !== blueprint) pendingBlueprint.blueprintId = createUuid();
        if (result !== null) task.file.checkpoint.result = { ...result, taskId: id, folderId: null,
          blueprint: { ...result.blueprint, blueprintId: blueprint!.blueprintId } };
        task.file.checkpoint.savedBlueprintId = null;
        await storage?.save(snapshot(task));
        tasks.set(id, task);
        latestId = id;
        notify();
        return id;
      },
    },
    queries: {
      listTasks: () => [...[...tasks.values()].map(task => ({ ...task.file.progress, elapsedMs: elapsed(task) })),
        ...[...blockedTasks.values()].map(task => ({ ...task.progress }))].sort((a, b) => b.startedAt - a.startedAt),
      getTask: (id = state.activeTaskId ?? latestId) => {
        const task = id === undefined ? undefined : tasks.get(id);
        return task ? { ...task.file.progress, elapsedMs: elapsed(task) }
          : id !== undefined && blockedTasks.has(id) ? { ...blockedTasks.get(id)!.progress } : null;
      },
      getLastRequest: (id = state.activeTaskId ?? latestId) => {
        const task = id === undefined ? undefined : tasks.get(id);
        return task ? structuredClone(task.file.request) : null;
      },
      getResult: id => structuredClone(tasks.get(id)?.file.checkpoint.result ?? null),
      exportTask: id => {
        assertReady();
        return blockedTasks.has(id) ? structuredClone(blockedTasks.get(id)!.file) : snapshot(requireTask(id));
      },
    },
    dispose() {
      disposed = true;
      for (const task of tasks.values()) { task.abort.abort(); persist(task); }
      worker.dispose();
      if (workspace.blueprintPlanner === host) workspace.blueprintPlanner = null;
    },
  };
  workspace.blueprintPlanner = host;
  return host;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// AI-REMOVED 2026-09-30:
// Reason: 单一内存任务替换为跨浏览器与无头客户端共用的持久化多任务状态机。
// Trigger: 用户授权任务历史、导出续算和独立预览。
// Evidence: 原 Host 仅持有一个 task，getResult 仅保存后返回。
// Replacement: 本文件 createBlueprintPlannerHost 与 task-checkpoint.ts。
// Risk: 检查点仅兼容明确声明的算法版本；中断时未完成搜索可能重做。
// Human Review: Required
// Original code:
// import { observable, runInAction } from "mobx";
// import type { WorkspaceContract } from "@/domain/document/workspace-contract";
// import type {
//   BlueprintPlannerContract, BlueprintPlannerProgress, BlueprintPlannerRequest, BlueprintPlannerResult,
// } from "@/domain/blueprint-planner";
// import { createUuid } from "@/domain/shared/uuid";
// import type { SimulationBlueprintRunReport } from "@/domain/simulation";
// import { createBlueprintFolder, listBlueprintDirectory, saveBlueprintDocument } from "@/shared/storage/blueprint-storage";
// import type { PlannerCandidate } from "./candidate";
// import { PlannerWorkerClient } from "./worker-client";
// import { PlannerCandidateError, PlanningBudgetExhausted } from "./model";
// import { meetsOperatingLimits, meetsProductionTargets } from "./verification";
// import { validatePlannerRequest } from "./production-network";
// import { PlannerSearchPortfolio } from "./search-portfolio";
//
// interface PlannerTask {
//   readonly id: string;
//   readonly request: BlueprintPlannerRequest;
//   readonly abort: AbortController;
//   readonly startedAt: number;
//   resumedAt: number | null;
//   spentMs: number;
//   progress: BlueprintPlannerProgress;
//   deadline: number;
//   budgetMs: number;
//   evaluationsPerRound: number;
//   attempt: number;
//   best: { candidate: PlannerCandidate; report: SimulationBlueprintRunReport } | null;
//   savedCandidate: PlannerCandidate | null;
//   result: BlueprintPlannerResult | null;
//   saving: Promise<void> | null;
//   pendingCandidate: PlannerCandidate | null;
//   readonly portfolio: PlannerSearchPortfolio;
// }
//
// // AI-REMOVED 2026-09-16:
// // Reason: 超时类型由 Worker 客户端与 Host 共用。
// // Trigger: 用户要求规划在 Worker 执行，并提供可重复的 Vitest 规划入口。
// // Evidence: 原 Host 直接调用 createPlannerCandidate；验证判定需要由生产与批量入口共用。
// // Replacement: ./model.ts
// // Risk: Low
// // Human Review: Required
// // Original code:
// // class PlanningBudgetExhausted extends Error {}
//
// export interface BlueprintPlannerHost extends BlueprintPlannerContract { dispose(): void; }
//
// export function createBlueprintPlannerHost(workspace: WorkspaceContract): BlueprintPlannerHost {
//   const state = observable<{ activeTaskId: string | null; revision: number }>({ activeTaskId: null, revision: 0 });
//   let task: PlannerTask | null = null;
//   let disposed = false;
//   const candidateWorker = new PlannerWorkerClient();
//   const elapsed = (current: PlannerTask) => current.spentMs + (current.resumedAt === null ? 0 : performance.now() - current.resumedAt);
//   const publish = (current: PlannerTask, patch: Partial<BlueprintPlannerProgress>) => {
//     if (patch.status !== undefined) {
//       const active = patch.status === "running" || patch.status === "saving";
//       if (!active && current.resumedAt !== null) { current.spentMs = elapsed(current); current.resumedAt = null; }
//       if (active && current.resumedAt === null) current.resumedAt = performance.now();
//     }
//     current.progress = { ...current.progress, ...patch, elapsedMs: elapsed(current) };
//     if (task === current) runInAction(() => { state.revision++; });
//   };
//   const finishActive = (current: PlannerTask) => {
//     if (task === current) runInAction(() => { state.activeTaskId = null; state.revision++; });
//   };
//   const checkBudget = (current: PlannerTask) => {
//     if (current.abort.signal.aborted || disposed) throw new DOMException("规划已取消", "AbortError");
//     if (performance.now() >= current.deadline) throw new PlanningBudgetExhausted();
//   };
//
//   async function save(current: PlannerTask): Promise<void> {
//     if (current.best === null || current.abort.signal.aborted) return;
//     publish(current, { status: "saving", phase: "saving", message: "正在保存蓝图", estimatedProgress: 0.99 });
//     try {
//       const directory = await listBlueprintDirectory();
//       const folder = directory.folders.find((entry) => entry.name === "自动规划") ?? await createBlueprintFolder({ name: "自动规划" });
//       if (folder === null) throw new Error("无法创建自动规划文件夹。");
//       const { candidate, report } = current.best;
//       const measuredOutputs = report.probes.filter(probe => current.request.plan.targets.some(target => target.itemId === probe.id))
//         .map((probe) => ({ itemId: probe.id, perMinute: probe.perMinute }));
//       const saved = await saveBlueprintDocument(candidate.execution.blueprint, { parentFolderId: folder.folderId });
//       if (saved === null) throw new Error("蓝图保存失败，请重试保存。");
//       current.result = {
//         taskId: current.id, blueprint: candidate.execution.blueprint, folderId: folder.folderId,
//         metrics: candidate.metrics, connections: candidate.connections, measuredOutputs,
//         warmupSeconds: candidate.execution.warmupSeconds, observationSeconds: report.observationSeconds,
//         elapsedMs: elapsed(current),
//       };
//       current.savedCandidate = candidate;
//       publish(current, { status: "completed", message: "规划完毕，蓝图已保存到用户蓝图/自动规划", estimatedProgress: 1 });
//     } catch (error) {
//       publish(current, { status: "save-failed", message: errorMessage(error), estimatedProgress: null });
//     } finally {
//       finishActive(current);
//     }
//   }
//
//   async function run(current: PlannerTask): Promise<void> {
//     let lastFailure = "尚未找到通过验证的布局";
//     try {
//       while (!current.abort.signal.aborted && !disposed) {
//         checkBudget(current);
//         const attempt = current.attempt++;
//         publish(current, { candidateCount: current.attempt, message: `正在搜索第 ${current.attempt} 个布局` });
//         try {
//           const search = current.portfolio.next(attempt);
//           const candidate = current.pendingCandidate ?? await candidateWorker.build(search.request, search.variant,
//             Math.max(1, current.deadline - performance.now()), current.evaluationsPerRound, current.abort.signal,
//             (phase, message) => publish(current, { phase, message, estimatedProgress: Math.min(0.95, 1 - Math.max(0, current.deadline - performance.now()) / current.budgetMs) }),
//             search.seed, search.continuationStep, search.maximumArea);
//           checkBudget(current);
//           const simulation = workspace.simulation;
//           if (simulation === null) throw new Error("仿真服务不可用。");
//           publish(current, { phase: "verification", message: "正在验证产量与循环运行" });
//           const report = await simulation.actions.runBlueprint({ ...candidate.execution, maxWallTimeMs: Math.max(1, current.deadline - performance.now()) }, current.abort.signal);
//           if (current.abort.signal.aborted) break;
//           if (!meetsProductionTargets(current.request, report) || !meetsOperatingLimits(candidate.supplyAudit, report)) {
//             current.pendingCandidate = report.status === "timeout" ? candidate : null;
//             lastFailure = report.diagnostics.find((entry) => entry.severity === "error")?.message
//               ?? (report.status === "timeout" ? "本轮验证达到时间预算" : "本轮布局的实际产量未达到目标");
//             continue;
//           }
//           current.pendingCandidate = null;
//           current.portfolio.remember(candidate.seed);
//           publish(current, { validatedCandidateCount: current.progress.validatedCandidateCount + 1, phase: "optimization", message: "已找到可用产线，正在比较更紧凑的布局" });
//           if (current.best === null || candidate.metrics.area < current.best.candidate.metrics.area
//             || (candidate.metrics.area === current.best.candidate.metrics.area
//               && (candidate.search.quality?.secondary ?? candidate.metrics.score)
//                 < (current.best.candidate.search.quality?.secondary ?? current.best.candidate.metrics.score))) {
//             current.best = { candidate, report };
//             publish(current, { bestArea: candidate.metrics.area });
//           }
//         } catch (error) {
//           if (!(error instanceof PlannerCandidateError) || current.abort.signal.aborted) throw error;
//           lastFailure = errorMessage(error);
//           publish(current, { message: lastFailure });
//         }
//         await new Promise<void>((resolve) => setTimeout(resolve, 0));
//       }
//     } catch (error) {
//       if (!(error instanceof PlanningBudgetExhausted) && !current.abort.signal.aborted) {
//         publish(current, { status: "failed", message: errorMessage(error), estimatedProgress: null });
//         finishActive(current);
//         return;
//       }
//     }
//     if (current.abort.signal.aborted || disposed) {
//       publish(current, { status: "cancelled", message: "规划已取消", estimatedProgress: null });
//       finishActive(current);
//     // AI-REMOVED 2026-09-22:
//     // Reason: 找到候选后自动保存会终止交互，用户无法在同一任务上手动追加无限轮计算。
//     // Trigger: 用户要求结果生成后手动保存，保存后按钮禁用，同时仍可继续规划下一轮。
//     // Evidence: 原分支直接调用 save(current)，save 成功后发布 completed；UI 只能显示“重新规划”。
//     // Replacement: 下方按“是否有未保存最佳候选”发布 waiting/completed，保存仅由 actions.save 触发。
//     // Risk: 结果现在必须由用户主动保存；关闭对话框不会自动落盘。
//     // Human Review: Required
//     //
//     // Original code:
//     // } else if (current.best !== null) {
//     //   current.saving = save(current);
//     //   await current.saving;
//     //   current.saving = null;
//     // } else {
//     //   publish(current, { status: "waiting", message: `本轮时间已用完；${lastFailure}。可以继续规划。`, estimatedProgress: null });
//     // }
//     } else if (current.best !== null && current.best.candidate !== current.savedCandidate) {
//       publish(current, { status: "waiting", message: "本轮规划完成；已找到新的最优结果，可以保存蓝图或继续规划。", estimatedProgress: null });
//       finishActive(current);
//     } else if (current.best !== null) {
//       publish(current, { status: "completed", message: "本轮规划完成；当前最优蓝图已保存，可以继续规划。", estimatedProgress: null });
//       finishActive(current);
//     } else {
//       publish(current, { status: "waiting", message: `本轮时间已用完；${lastFailure}。可以继续规划。`, estimatedProgress: null });
//       finishActive(current);
//     }
//   }
//
//   const host: BlueprintPlannerHost = {
//     state,
//     actions: {
//       start(request) {
//         if (disposed) throw new Error("规划器已关闭。");
//         if (state.activeTaskId !== null) throw new Error("已有规划任务，请先取消或等待完成。");
//         validatePlannerRequest(workspace.registry, request);
//         if (workspace.simulation === null) throw new Error("仿真服务不可用。");
//         const snapshot = structuredClone(request);
//         workspace.simulation.actions.stop();
//         const id = createUuid(), startedAt = Date.now();
//         const current: PlannerTask = {
//           id, request: snapshot, abort: new AbortController(), startedAt, resumedAt: performance.now(), spentMs: 0,
//           deadline: performance.now() + snapshot.options.budgetMs, budgetMs: snapshot.options.budgetMs,
//           evaluationsPerRound: snapshot.options.evaluationsPerRound,
//           attempt: 0, best: null, savedCandidate: null, result: null, saving: null, pendingCandidate: null,
//           portfolio: new PlannerSearchPortfolio(snapshot),
//           progress: { taskId: id, status: "running", phase: "preparing", startedAt, elapsedMs: 0, estimatedProgress: 0,
//             candidateCount: 0, validatedCandidateCount: 0, bestArea: null, message: null },
//         };
//         task = current;
//         runInAction(() => { state.activeTaskId = id; state.revision++; });
//         void run(current);
//         return id;
//       },
//       continuePlanning(taskId, additionalBudgetMs, evaluationsPerRound) {
//         if (task?.id !== taskId || !["waiting", "completed"].includes(task.progress.status)) throw new Error("任务当前不能继续。");
//         if (!Number.isFinite(additionalBudgetMs) || additionalBudgetMs <= 0) throw new Error("追加时间必须大于零。");
//         if (!Number.isSafeInteger(evaluationsPerRound) || evaluationsPerRound < 1_000
//           || evaluationsPerRound % 1_000 !== 0) throw new Error("每轮计算次数必须是大于零的 1000 整数倍。");
//         const current = task;
//         current.budgetMs = additionalBudgetMs;
//         current.evaluationsPerRound = evaluationsPerRound;
//         current.deadline = performance.now() + current.budgetMs;
//         runInAction(() => { state.activeTaskId = current.id; state.revision++; });
//         publish(current, { status: "running", message: "继续搜索布局", estimatedProgress: 0 });
//         void run(current);
//       },
//       async save(taskId) {
//         if (task?.id !== taskId || task.progress.status !== "waiting" || task.best === null
//           || task.best.candidate === task.savedCandidate) throw new Error("当前没有可保存的新结果。");
//         const current = task;
//         runInAction(() => { state.activeTaskId = current.id; state.revision++; });
//         current.saving ??= save(current);
//         try { await current.saving; } finally { current.saving = null; }
//       },
//       cancel(taskId) {
//         if (task?.id !== taskId || !["running", "waiting"].includes(task.progress.status)) return;
//         task.abort.abort();
//         publish(task, { status: "cancelled", message: "规划已取消", estimatedProgress: null });
//         finishActive(task);
//       },
//       async retrySave(taskId) {
//         if (task?.id !== taskId || task.progress.status !== "save-failed") throw new Error("任务当前不能重试保存。");
//         const current = task;
//         runInAction(() => { state.activeTaskId = current.id; state.revision++; });
//         current.saving ??= save(current);
//         try { await current.saving; } finally { current.saving = null; }
//       },
//     },
//     queries: {
//       getTask: () => task === null ? null : { ...task.progress, elapsedMs: elapsed(task) },
//       getLastRequest: () => task === null ? null : structuredClone(task.request),
//       getResult: (taskId) => task?.id === taskId && task.result !== null ? structuredClone(task.result) : null,
//     },
//     dispose() {
//       disposed = true;
//       candidateWorker.dispose();
//       task?.abort.abort();
//       if (workspace.blueprintPlanner === host) workspace.blueprintPlanner = null;
//     },
//   };
//   workspace.blueprintPlanner = host;
//   return host;
// }
//
// // AI-REMOVED 2026-09-16:
// // Reason: 生产任务与批量测试必须使用同一可用性门槛。
// // Trigger: 用户要求规划在 Worker 执行，并提供可重复的 Vitest 规划入口。
// // Evidence: 原 Host 直接调用 createPlannerCandidate；验证判定需要由生产与批量入口共用。
// // Replacement: ./verification.ts
// // Risk: Low
// // Human Review: Required
// // Original code:
// // function meetsProductionTargets(request: BlueprintPlannerRequest, report: SimulationBlueprintRunReport): boolean {
// //   if (report.status !== "completed" || report.observationSeconds <= 0
// //     || report.diagnostics.some((entry) => entry.severity === "error")
// //     || report.deviceStatuses.some((entry) => entry.status === "not-in-power-net" || entry.status === "no-power")) return false;
// //   return request.plan.targets.every((target) => (report.probes.find((probe) => probe.id === target.itemId)?.perMinute ?? 0) + 1e-6 >= target.perMinute * 0.98);
// // }
//
// function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
