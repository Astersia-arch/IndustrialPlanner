import { useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import type { BlueprintPlannerAreaPoint, BlueprintPlannerOptions, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import type { UiKey } from "@/shared/i18n";
import type { AppHost } from "../host";
import { enterBlueprintPlacement } from "../input";
import { DialogShell } from "./shared/dialog-shell";
import { PlannerTaskFlow } from "./production-planning";
import { plannerAreaTicks, plannerProposalRate, samplePlannerProposalRate } from "./blueprint-planner-statistics";
import styles from "./blueprint-planner-dialog.module.scss";

const OPTION_FIELDS: readonly { key: Exclude<keyof BlueprintPlannerOptions, "evaluationsPerRound" | "concurrency">; label: UiKey; choices: readonly [string, UiKey][] }[] = [
  { key: "solidSupply", label: "eda.solidSupply", choices: [["external", "eda.externalBelt"], ["warehouse", "eda.warehouseSupply"]] },
  { key: "fluidSupply", label: "eda.fluidSupply", choices: [["external", "eda.externalPipe"], ["conduit", "eda.conduitSupply"]] },
  { key: "warehouseBus", label: "eda.warehouseBus", choices: [["straight", "eda.straight"], ["free", "eda.free"]] },
  { key: "solidOutput", label: "eda.solidOutput", choices: [["auto", "eda.autoOutput"], ["warehouse", "eda.warehouseOutput"], ["stash", "eda.stashOutput"]] },
  { key: "byproducts", label: "eda.byproducts", choices: [["output", "eda.output"], ["destroy", "eda.destroy"]] },
  { key: "plantStartup", label: "eda.plantStartup", choices: [["preload", "eda.preload"], ["warehouse", "eda.warehouseStartup"]] },
];

function AreaCurve({ points, proposals, label }: { points: readonly BlueprintPlannerAreaPoint[]; proposals: number; label: string }) {
  const width = 600, left = 46, right = 588, top = 12, bottom = 132;
  const ticks = plannerAreaTicks(points, proposals, left, right);
  const height = bottom + 28;
  const maxX = Math.max(1, proposals);
  const minArea = Math.min(...points.map(point => point.bestArea));
  const maxArea = Math.max(...points.map(point => point.bestArea));
  const span = Math.max(1, maxArea - minArea);
  const x = (value: number) => left + value / maxX * (right - left);
  const y = (value: number) => bottom - ((value - minArea) / span * (bottom - top - 20) + 10);
  const first = points[0]!;
  const path = [`M ${x(first.evaluatedProposals)} ${y(first.bestArea)}`];
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!;
    path.push(`H ${x(point.evaluatedProposals)} V ${y(point.bestArea)}`);
  }
  path.push(`H ${x(maxX)}`);
  return <figure className={styles.areaCurve}>
    <figcaption>{label}</figcaption>
    <div className={styles.areaPlot}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}: ${maxX.toLocaleString()}, ${points.at(-1)!.bestArea}`}>
      <path className={styles.areaAxis} d={`M ${left} ${top} V ${bottom} H ${right}`} />
      <path className={styles.areaLine} d={path.join(" ")} />
      {points.map(point => <circle key={`${point.evaluatedProposals}-${point.bestArea}`}
        className={styles.areaPoint} cx={x(point.evaluatedProposals)} cy={y(point.bestArea)} r="3.5">
        <title>{`${point.evaluatedProposals.toLocaleString()} · ${point.bestArea}`}</title>
      </circle>)}
      {/* AI-REMOVED 2026-10-03:
        Reason: 仅首尾刻度不能标注每次面积下降。Trigger: 用户要求 X 轴记录下降时的提案次数。
        Evidence: 原图仅绘制 0 与累计总数。Replacement: 下方 ticks，密集标签错行。
        Risk: 下降点密集时图表增高。Human Review: Required
        Original code:
        <text x={left} y={height - 4} textAnchor="start">0</text>
        <text x={right} y={height - 4} textAnchor="end">{maxX.toLocaleString()}</text>
      */}
      {ticks.map(tick => <g key={tick.value}>
        <path className={styles.areaTick} d={`M ${tick.x} ${bottom} V ${bottom + 5}`} />
        <text x={tick.labelX} y={bottom + 18} textAnchor="start">{tick.label}</text>
      </g>)}
      <text x={left - 5} y={y(maxArea) + 4} textAnchor="end">{maxArea}</text>
      {minArea !== maxArea ? <text x={left - 5} y={y(minArea) + 4} textAnchor="end">{minArea}</text> : null}
    </svg></div>
  </figure>;
}

export const BlueprintPlannerDialog = observer(function BlueprintPlannerDialog({ appHost }: { appHost: AppHost }) {
  const controller = appHost.blueprintPlannerDialog;
  const planner = appHost.workspace.blueprintPlanner;
  const t = appHost.actions.translate;
  const [, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [recentRate, setRecentRate] = useState<ReturnType<typeof samplePlannerProposalRate>>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedId = controller.viewTaskId;
  useEffect(() => {
    if (!controller.dialogState.visible) return;
    const interval = setInterval(() => {
      const current = selectedId === null ? null : planner?.queries.getTask(selectedId) ?? null;
      setRecentRate(previous => samplePlannerProposalRate(previous, current));
      refresh(value => value + 1);
    }, 500);
    return () => clearInterval(interval);
  }, [controller.dialogState.visible, planner, selectedId]);
  const revision = planner?.state.revision ?? 0;
  // AI-REMOVED 2026-10-03:
  // Reason: 采样定时器必须跟随选中任务重建。Trigger: 新增提案速度。
  // Evidence: effect 需要 selectedId 作为依赖。Replacement: 上方 effect 前的同名声明。
  // Risk: Low。Human Review: Required
  // Original code:
  // const selectedId = controller.viewTaskId;
  const progress = selectedId === null ? null : planner?.queries.getTask(selectedId) ?? null;
  const result = useMemo(() => {
    void revision;
    return selectedId === null ? null : planner?.queries.getResult(selectedId) ?? null;
  }, [planner, revision, selectedId]);
  const history = useMemo(() => {
    void revision;
    return planner?.queries.listTasks().map(task => ({ ...task, name: planner.queries.getLastRequest(task.taskId)?.plan.name ?? task.taskId })) ?? [];
  }, [planner, revision]);
  if (!controller.dialogState.visible) return null;
  const busy = progress !== null && ["running", "saving"].includes(progress.status);
  const anyBusy = planner?.state.activeTaskId != null;
  const compact = appHost.state.screenProfile.deviceClass === "mobile";
  const plan = controller.plan;
  const validRoundSettings = Number.isSafeInteger(controller.options.evaluationsPerRound) && controller.options.evaluationsPerRound >= 10_000
    && controller.options.evaluationsPerRound % 10_000 === 0;
  // AI-REMOVED 2026-10-03:
  // Reason: 界面不再输入数字，校验与核心数告警由自动调度替代。
  // Trigger: 用户授权自动 CPU 并发。Evidence: Host 按吞吐和响应调节。
  // Replacement: 下方只读自动状态。Risk: Low。Human Review: Required
  // Original code:
  //   const validConcurrency = Number.isSafeInteger(controller.options.concurrency) && controller.options.concurrency! >= 1
  //     && controller.options.concurrency! <= 32;
  //   const hardwareConcurrency = typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  //   const warnConcurrency = shouldWarnPlannerConcurrency(controller.options.concurrency ?? 1, hardwareConcurrency);
  const act = (action: () => void | Promise<void>) => {
    setError(null);
    try { void Promise.resolve(action()).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const select = (id: string) => {
    const request = planner?.queries.getLastRequest(id);
    controller.selectTask(id, request ?? undefined);
    setError(null);
  };
  const openProductionPlanning = () => {
    controller.close();
    appHost.internalActions.setDialogTab("toolbox", "production-planning");
    appHost.internalActions.openDialog("toolbox");
  };
  const place = (source: "mouse" | "touch") => act(() => {
    const editor = appHost.workspace.editor;
    if (result === null || editor === null) return;
    const entered = enterBlueprintPlacement({ appHost, editor,
      record: { ...result.blueprint, parentFolderId: result.folderId }, source, initialMousePosition: null });
    if (entered.status === "handled") controller.close(); else setError(t("eda.placeFailed"));
  });
  const download = () => act(() => {
    if (!planner || selectedId === null) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(planner.queries.exportTask(selectedId))], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${(plan?.name || "eda-task").replace(/[/\\:*?"<>|]/g, "-")}.eda-task.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const elapsed = Math.floor((progress?.elapsedMs ?? 0) / 1000);
  const rate = progress?.status !== "running" ? 0 : recentRate?.taskId === progress.taskId
    && recentRate.roundStart === progress.evaluatedProposals - progress.roundEvaluatedProposals ? recentRate.rate : null;
  const statusLabel = (status: string) => t(status === "running" ? "eda.running" : status === "saving" ? "eda.saving"
    : status === "failed" || status === "save-failed" ? "eda.failed" : status === "completed" ? "eda.saved" : "eda.paused");
  return <DialogShell dialogKey="blueprint-planner" dialogState={controller.dialogState}
    title={t("eda.title")} titleId="blueprint-planner-title" closeTitle={t("action.close")}
    maximizeTitle={t("dialog.maximize")} restoreTitle={t("dialog.restore")}
    onClose={controller.close} onToggleMaximized={controller.toggleMaximized}
    onOffsetChange={controller.setOffset} onResize={compact ? undefined : controller.setSize}
    compactMobileLayout={compact} immersiveMaximized={controller.dialogState.maximized && appHost.state.screenProfile.deviceClass !== "desktop"}
    shellStyle={controller.dialogState.width === null ? { width: "min(1080px, 100%)", height: "min(760px, 100%)" } : undefined}>
    <div className={`${styles.content} ${compact ? styles.compact : ""}`}>
      <aside className={styles.history} aria-label={t("eda.history")}>
        <strong>{t("eda.history")}</strong>
        <button type="button" onClick={openProductionPlanning}>{t("eda.newTask")}</button>
        <button type="button" disabled={fileBusy} onClick={() => inputRef.current?.click()}>{t("eda.importTask")}</button>
        <input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file || !planner) return;
          act(async () => {
            setFileBusy(true);
            try {
              if (file.size > 100 * 1024 * 1024) throw new Error(t("eda.fileTooLarge"));
              const id = await planner.actions.importTask(JSON.parse(await file.text()) as BlueprintPlannerTaskFile);
              select(id);
            } finally { setFileBusy(false); }
          });
        }} />
        <div className={styles.taskList}>
          {history.length === 0 ? <p>{t("eda.noHistory")}</p> : history.map(task => <button type="button" key={task.taskId}
            className={styles.task} aria-pressed={selectedId === task.taskId} onClick={() => select(task.taskId)}>
            <strong>{task.name}</strong><span>{t("eda.productionMode")} · {statusLabel(task.status)}</span>
            <time>{new Date(task.startedAt).toLocaleString()}</time>
          </button>)}
        </div>
      </aside>
      <div className={styles.main}>
        <div className={styles.scroll}>
              {selectedId !== null ? <div className={styles.taskActions}>
                <button type="button" onClick={download}>{t("eda.downloadTask")}</button>
                <button type="button" disabled={busy || fileBusy} onClick={() => act(async () => {
                  if (!planner || !window.confirm(t("eda.confirmDelete"))) return;
                  setFileBusy(true);
                  try {
                    await planner.actions.deleteTask(selectedId);
                    const next = planner.queries.listTasks()[0];
                    if (next) select(next.taskId); else controller.selectTask(null);
                  } finally { setFileBusy(false); }
                })}>{t("eda.deleteTask")}</button>
              </div> : null}
          {plan === null && progress === null ? <div className={styles.empty}><p>{t("eda.noPlan")}</p>
            <button type="button" onClick={openProductionPlanning}>{t("eda.openProductionPlanning")}</button></div> : plan !== null ? <>
            <div className={styles.heading}><div><span>{t("eda.productionMode")}</span><p className={styles.target}>{plan.name}</p></div>

            </div>
            <div className={styles.flow} aria-label={t("productionPlanning.modeDevice")}>
              <PlannerTaskFlow key={selectedId ?? "draft"} plan={plan} registry={appHost.workspace.registry} t={t} />
            </div>
            <fieldset className={styles.options} disabled={busy}>
              {OPTION_FIELDS.map(field => <label key={field.key}><span>{t(field.label)}</span>
                <select disabled={progress !== null} value={controller.options[field.key]}
                  onChange={event => controller.updateOptions({ [field.key]: event.target.value })}>
                  {field.choices.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                </select></label>)}
              {/* AI-REMOVED 2026-09-30: 用户批准删除时间预算；替代：下方提案预算。Risk: Low。Human Review: Required
              <label><span>{t("eda.budget")}</span><input type="number" min="10" step="10" value={controller.options.budgetMs / 1000}
                onChange={event => controller.updateOptions({ budgetMs: Number(event.target.value) * 1000 })} /></label>
              */}
              <label><span>{t("eda.evaluationsPerRound")}</span><input type="number" min="1" step="1" value={controller.options.evaluationsPerRound / 10_000}
                onChange={event => controller.updateOptions({ evaluationsPerRound: Number(event.target.value) * 10_000 })} /></label>
              {/* AI-REMOVED 2026-10-03:
                Reason: 并发数不再由用户手填。Trigger: 用户确认自动并发。
                Evidence: Planner 自动调度与 activeWorkerCount 契约。
                Replacement: 下方自动状态输出。Risk: Low。Human Review: Required
                Original code:
              <label><span>{t("eda.concurrency")}</span><input type="number" min="1" max="32" step="1"
                value={controller.options.concurrency ?? 1}
                aria-describedby={warnConcurrency ? "eda-concurrency-warning" : undefined}
                onChange={event => controller.updateOptions({ concurrency: Number(event.target.value) })} />
                {warnConcurrency ? <span id="eda-concurrency-warning" role="status" className={styles.error}>
                  {t("eda.concurrencyWarning").replace("{cores}", String(hardwareConcurrency))}
                </span> : null}</label>
              */}
              {/* AI-REMOVED 2026-10-03:
                Reason: 只读并发数不能切换单 Worker，而且搜索与验证交替会显示 0/1。
                Trigger: 用户要求 CPU+GPU 复选框。Evidence: Windows 真机决策记录。
                Replacement: 下方复选框。Risk: Low。Human Review: Required
                Original code:
              <label><span>{t("eda.concurrency")}</span><output>
                {progress?.status === "running" ? t("eda.activeConcurrency").replace("{count}", String(progress.activeWorkerCount ?? 0))
                  : t("eda.autoConcurrency")}
              </output></label>
              */}
              <label className={styles.parallel}><input type="checkbox" checked={controller.options.concurrency === "auto"}
                onChange={event => controller.updateOptions({ concurrency: event.target.checked ? "auto" : 1 })} />
                <span>{t("eda.concurrency")}</span></label>
            </fieldset>
            {plan.containsModules ? <p role="alert" className={styles.error}>{t("eda.modulesUnsupported")}</p> : null}
          </> : null}
          {progress !== null ? <section className={styles.progress} aria-live="polite">
            <div className={styles.statistics}>
              <span>{statusLabel(progress.status)}</span>
              <span>{t("eda.elapsed")} <strong>{`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}</strong></span>
              <span>{t("eda.candidates")} <strong>{progress.candidateCount}</strong></span>
              {progress.bestArea !== null ? <span>{t("eda.bestArea")} <strong>{progress.bestArea}</strong></span> : null}
            </div>
            {busy ? <progress aria-label={t("eda.progress")} max={1} value={progress.estimatedProgress ?? undefined} /> : null}
            <div className={styles.statistics}>
              <span>{t("eda.roundProposals")} <strong>{progress.roundEvaluatedProposals.toLocaleString()} / {planner?.queries.getLastRequest(progress.taskId)?.options.evaluationsPerRound.toLocaleString()}</strong>{" "}
                <span className={styles.proposalRate} title={t("eda.recentRate")}>({rate === null ? "—" : rate.toLocaleString()} {t("eda.proposalsPerSecond")})</span></span>
              <span>{t("eda.totalProposals")} <strong>{progress.evaluatedProposals.toLocaleString()}</strong>{" "}
                <span className={styles.proposalRate} title={t("eda.averageRate")}>({plannerProposalRate(progress.evaluatedProposals, progress.elapsedMs).toLocaleString()} {t("eda.proposalsPerSecond")})</span></span>
            </div>
            <p>{progress.message}</p>
            {progress.areaHistory?.length ? <AreaCurve points={progress.areaHistory}
              proposals={progress.evaluatedProposals} label={t("eda.areaCurve")} /> : null}
            {result !== null ? <p>{result.metrics.width} × {result.metrics.height} · {result.metrics.productionDeviceCount} {t("eda.devices")}</p> : null}
          </section> : null}
          {error !== null ? <p role="alert" className={styles.error}>{error}</p> : null}
        </div>
        <footer className={styles.footer}>
          {progress?.status === "running" ? <button type="button" onClick={() => act(() => planner?.actions.cancel(progress.taskId))}>{t("eda.pause")}</button> : null}
          {progress !== null && plan !== null && !busy ? <button type="button" disabled={!validRoundSettings || anyBusy}
            onClick={() => act(() => planner?.actions.continuePlanning(progress.taskId,
              controller.options.evaluationsPerRound, controller.options.concurrency))}>{t("eda.continue")}</button> : null}
          {result !== null ? <>
            <button type="button" onClick={() => {
              appHost.blueprintPreview.open({ ...result.blueprint, parentFolderId: result.folderId }, { canDelete: false });
              // AI-REMOVED 2026-09-30:
              // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
              // Trigger: 用户批准本轮接口与交互调整。
              // Evidence: 原实现使用时间截止或关闭任务面板。
              // Replacement: 保留规划面板，由预览窗口管理自身关闭
              // Risk: Low。Human Review: Required
              // Original code:
              // controller.close();

            }}>{t("eda.preview")}</button>
            <button type="button" className={styles.primary} disabled={anyBusy || result.folderId !== null}
              onClick={() => act(() => planner?.actions.save(result.taskId))}>{t(progress?.status === "save-failed" ? "eda.retrySave" : "eda.save")}</button>
            <button type="button" onPointerUp={event => place(event.pointerType === "mouse" ? "mouse" : "touch")}
              onClick={event => { if (event.detail === 0) place("mouse"); }}>{t("eda.place")}</button>
          </> : null}
          {progress === null && plan !== null ? <button type="button" className={styles.primary}
            disabled={plan.containsModules || !planner || anyBusy || !validRoundSettings} onClick={() => act(() => {
              if (planner) select(planner.actions.start(controller.getRequest()));
            })}>{t("eda.start")}</button> : null}
        </footer>
      </div>
    </div>
  </DialogShell>;
});

// AI-REMOVED 2026-09-30:
// Reason: 单面板改为任务历史、设备流向图与未保存结果操作。
// Trigger: 用户授权任务化规划界面。
// Evidence: 原组件只展示 latest 单任务，不支持历史选择与导入导出。
// Replacement: 本文件 BlueprintPlannerDialog。
// Risk: Low；沿用 DialogShell 和规划契约。
// Human Review: Required
// Original code:
// import { useEffect, useMemo, useState } from "react";
// import { observer } from "mobx-react-lite";
// import type { BlueprintPlannerOptions } from "@/domain/blueprint-planner";
// import type { UiKey } from "@/shared/i18n";
// import type { AppHost } from "../host";
// import { enterBlueprintPlacement } from "../input";
// import { DialogShell } from "./shared/dialog-shell";
// import styles from "./blueprint-planner-dialog.module.scss";
//
// const OPTION_FIELDS: readonly { key: Exclude<keyof BlueprintPlannerOptions, "budgetMs" | "evaluationsPerRound">; label: UiKey; choices: readonly [string, UiKey][] }[] = [
//   { key: "solidSupply", label: "eda.solidSupply", choices: [["external", "eda.externalBelt"], ["warehouse", "eda.warehouseSupply"]] },
//   { key: "fluidSupply", label: "eda.fluidSupply", choices: [["external", "eda.externalPipe"], ["conduit", "eda.conduitSupply"]] },
//   { key: "warehouseBus", label: "eda.warehouseBus", choices: [["straight", "eda.straight"], ["free", "eda.free"]] },
//   { key: "solidOutput", label: "eda.solidOutput", choices: [["auto", "eda.autoOutput"], ["warehouse", "eda.warehouseOutput"], ["stash", "eda.stashOutput"]] },
//   { key: "byproducts", label: "eda.byproducts", choices: [["output", "eda.output"], ["destroy", "eda.destroy"]] },
//   { key: "plantStartup", label: "eda.plantStartup", choices: [["preload", "eda.preload"], ["warehouse", "eda.warehouseStartup"]] },
// ];
//
// export const BlueprintPlannerDialog = observer(function BlueprintPlannerDialog({ appHost }: { appHost: AppHost }) {
//   const controller = appHost.blueprintPlannerDialog;
//   const planner = appHost.workspace.blueprintPlanner;
//   const t = appHost.actions.translate;
//   const [, refresh] = useState(0);
//   const [error, setError] = useState<string | null>(null);
//   useEffect(() => {
//     if (!controller.dialogState.visible) return;
//     const interval = setInterval(() => refresh((value) => value + 1), 250);
//     return () => clearInterval(interval);
//   }, [controller.dialogState.visible]);
//   const latest = planner?.queries.getTask() ?? null;
//   const progress = latest?.taskId === controller.viewTaskId ? latest : null;
//   const plannerRevision = planner?.state.revision ?? 0;
//   const result = useMemo(() => {
//     void plannerRevision;
//     return progress === null ? null : planner?.queries.getResult(progress.taskId) ?? null;
//   }, [planner, plannerRevision, progress]);
//   if (!controller.dialogState.visible) return null;
//   const busy = progress !== null && ["running", "saving"].includes(progress.status);
//   const compact = appHost.state.screenProfile.deviceClass === "mobile";
//   const plan = controller.plan;
//   const validRoundSettings = Number.isFinite(controller.options.budgetMs) && controller.options.budgetMs > 0
//     && Number.isSafeInteger(controller.options.evaluationsPerRound) && controller.options.evaluationsPerRound >= 1_000
//     && controller.options.evaluationsPerRound % 1_000 === 0;
//   const act = (action: () => void) => {
//     setError(null);
//     try { action(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
//   };
//   const start = () => act(() => {
//     if (planner === null) throw new Error(t("eda.unavailable"));
//     controller.selectTask(planner.actions.start(controller.getRequest()));
//   });
//   const openProductionPlanning = () => {
//     controller.close();
//     appHost.internalActions.setDialogTab("toolbox", "production-planning");
//     appHost.internalActions.openDialog("toolbox");
//   };
//   const place = (source: "mouse" | "touch") => act(() => {
//     const editor = appHost.workspace.editor;
//     if (result === null || editor === null) return;
//     const entered = enterBlueprintPlacement({
//       appHost, editor, record: { ...result.blueprint, parentFolderId: result.folderId },
//       source, initialMousePosition: null,
//     });
//     if (entered.status === "handled") controller.close();
//     else setError(t("eda.placeFailed"));
//   });
//   const elapsed = Math.floor((progress?.elapsedMs ?? 0) / 1000);
//   return (
//     <DialogShell dialogKey="blueprint-planner" dialogState={controller.dialogState}
//       title={t("eda.title")} titleId="blueprint-planner-title" closeTitle={t("action.close")}
//       maximizeTitle={t("dialog.maximize")} restoreTitle={t("dialog.restore")}
//       onClose={controller.close} onToggleMaximized={controller.toggleMaximized}
//       onOffsetChange={controller.setOffset} onResize={compact ? undefined : controller.setSize}
//       compactMobileLayout={compact} immersiveMaximized={controller.dialogState.maximized && appHost.state.screenProfile.deviceClass !== "desktop"}
//       shellStyle={controller.dialogState.width === null ? { width: "min(660px, 100%)", height: "min(600px, 100%)" } : undefined}>
//       <div className={`${styles.content} ${compact ? styles.compact : ""}`}>
//         <div className={styles.scroll}>
//           {plan === null && progress === null ? <div className={styles.empty}>
//             <p>{t("eda.noPlan")}</p>
//             <button type="button" onClick={openProductionPlanning}>{t("eda.openProductionPlanning")}</button>
//           </div> : <>
//             <p className={styles.target}>{plan.name || plan.targets.map((flow) => {
//               const item = appHost.workspace.registry.queries.findItemDefinition(flow.itemId);
//               return `${item === null ? flow.itemId : t(item.nameKey)} ${flow.perMinute}/min`;
//             }).join(" · ")}</p>
//             <fieldset className={styles.options} disabled={progress?.status === "running" || progress?.status === "saving"}>
//               {OPTION_FIELDS.map((field) => <label key={field.key}>
//                 <span>{t(field.label)}</span>
//                 <select disabled={busy || progress !== null} value={controller.options[field.key]} onChange={(event) => controller.updateOptions({ [field.key]: event.target.value })}>
//                   {field.choices.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
//                 </select>
//               </label>)}
//               <label><span>{t("eda.budget")}</span>
//                 <input type="number" min="10" step="10" value={controller.options.budgetMs / 1000}
//                   onChange={(event) => controller.updateOptions({ budgetMs: Number(event.target.value) * 1000 })} />
//               </label>
//               <label><span>{t("eda.evaluationsPerRound")}</span>
//                 <input type="number" min="1000" step="1000" value={controller.options.evaluationsPerRound}
//                   onChange={(event) => controller.updateOptions({ evaluationsPerRound: Number(event.target.value) })} />
//               </label>
//             </fieldset>
//             {plan.containsModules ? <p role="alert" className={styles.error}>{t("eda.modulesUnsupported")}</p> : null}
//           </>}
//           {progress !== null ? <section className={styles.progress} aria-live="polite">
//             <div className={styles.statistics}>
//               <span>{t("eda.elapsed")} <strong>{`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}</strong></span>
//               <span>{t("eda.candidates")} <strong>{progress.candidateCount}</strong></span>
//               {progress.bestArea !== null ? <span>{t("eda.bestArea")} <strong>{progress.bestArea}</strong></span> : null}
//             </div>
//             {busy ? <progress aria-label={t("eda.progress")} max={1} value={progress.estimatedProgress ?? undefined} /> : null}
//             <p>{progress.message}</p>
//             {result !== null ? <p>{result.metrics.width} × {result.metrics.height} · {result.metrics.productionDeviceCount} {t("eda.devices")}</p> : null}
//           </section> : null}
//           {error !== null ? <p role="alert" className={styles.error}>{error}</p> : null}
//         </div>
//         <footer className={styles.footer}>
//           {progress?.status === "running" || progress?.status === "waiting" ? <button type="button" onClick={() => act(() => planner?.actions.cancel(progress.taskId))}>{t("action.cancel")}</button> : null}
//           {progress !== null && ["waiting", "completed"].includes(progress.status) ? <button type="button"
//             disabled={!validRoundSettings}
//             onClick={() => act(() => planner?.actions.continuePlanning(progress.taskId, controller.options.budgetMs, controller.options.evaluationsPerRound))}>{t("eda.continue")}</button> : null}
//           {progress?.bestArea !== null && progress?.bestArea !== undefined ? <button type="button" className={styles.primary}
//             disabled={progress.status !== "waiting"}
//             onClick={() => {
//               setError(null);
//               void planner?.actions.save(progress.taskId).catch((failure: unknown) => setError(String(failure)));
//             }}>{t("eda.save")}</button> : null}
//           {progress?.status === "save-failed" ? <button type="button" className={styles.primary} onClick={() => {
//             setError(null);
//             void planner?.actions.retrySave(progress.taskId).catch((failure: unknown) => setError(String(failure)));
//           }}>{t("eda.retrySave")}</button> : null}
//           {!busy && plan !== null && (progress === null || ["cancelled", "failed"].includes(progress.status)) ? <button type="button"
//             disabled={plan.containsModules || planner === null || !validRoundSettings}
//             className={result === null ? styles.primary : undefined} onClick={start}>{t(progress === null ? "eda.start" : "eda.replan")}</button> : null}
//           {result !== null ? <button type="button" className={styles.primary}
//             onPointerUp={(event) => place(event.pointerType === "mouse" ? "mouse" : "touch")}
//             onClick={(event) => { if (event.detail === 0) place("mouse"); }}>
//             {t("eda.place")}
//           </button> : null}
//         </footer>
//       </div>
//     </DialogShell>
//   );
// });
