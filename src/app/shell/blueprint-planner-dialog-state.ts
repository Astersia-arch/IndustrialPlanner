import { makeAutoObservable, observable, toJS } from "mobx";
import type { BlueprintPlannerOptions, BlueprintPlannerProductionPlan, BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { readFromLocalStorage, saveToLocalStorage } from "@/shared/storage";
import { runStorageEffect } from "@/shared/storage/storage-failure";
import { createDefaultDialogStateForKey } from "../state";

const ENABLED_KEY = "industrial-planner.experimental.eda";
const OPTIONS_KEY = "industrial-planner.eda.options";

export class BlueprintPlannerDialogController {
  readonly dialogState = createDefaultDialogStateForKey("blueprint-planner");
  enabled = readFromLocalStorage<boolean>(ENABLED_KEY) === true;
  plan: BlueprintPlannerProductionPlan | null = null;
  viewTaskId: string | null = null;
  options: BlueprintPlannerOptions = {
    solidSupply: "warehouse", fluidSupply: "conduit", warehouseBus: "straight",
    solidOutput: "auto", byproducts: "destroy", plantStartup: "preload", evaluationsPerRound: 500_000,
  };

  constructor() {
    const saved = readFromLocalStorage<Partial<BlueprintPlannerOptions>>(OPTIONS_KEY);
    if (saved !== null) {
      for (const key of ["solidSupply", "fluidSupply", "warehouseBus", "solidOutput", "byproducts", "plantStartup"] as const) {
        const choices = {
          solidSupply: ["external", "warehouse"], fluidSupply: ["external", "conduit"], warehouseBus: ["straight", "free"],
          solidOutput: ["warehouse", "stash", "auto"], byproducts: ["destroy", "output"], plantStartup: ["preload", "warehouse"],
        };
        if (saved[key] !== undefined && choices[key].includes(saved[key]!)) this.options = { ...this.options, [key]: saved[key] };
      }
      // AI-REMOVED 2026-09-30:
      // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
      // Trigger: 用户批准本轮接口与交互调整。
      // Evidence: 原实现使用时间截止或关闭任务面板。
      // Replacement: src/app/shell/blueprint-planner-dialog-state.ts
      // Risk: Low。Human Review: Required
      // Original code:
      //       if (typeof saved.budgetMs === "number" && Number.isFinite(saved.budgetMs) && saved.budgetMs > 0) this.options = { ...this.options, budgetMs: saved.budgetMs };

      if (typeof saved.evaluationsPerRound === "number" && Number.isSafeInteger(saved.evaluationsPerRound)
        && saved.evaluationsPerRound >= 10_000 && saved.evaluationsPerRound % 10_000 === 0) {
        this.options = { ...this.options, evaluationsPerRound: saved.evaluationsPerRound };
      }
    }
    makeAutoObservable(this, { plan: observable.ref }, { autoBind: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    runStorageEffect("planner-enabled", () => saveToLocalStorage(ENABLED_KEY, enabled));
    if (!enabled) this.close();
  }

  open(plan?: BlueprintPlannerProductionPlan): void {
    if (plan !== undefined) { this.plan = structuredClone(plan); this.viewTaskId = null; }
    this.dialogState.visible = true;
  }

  selectTask(taskId: string | null, request?: BlueprintPlannerRequest): void {
    this.viewTaskId = taskId;
    if (taskId === null || !request) this.plan = null;
    if (request) { this.plan = structuredClone(request.plan); this.options = structuredClone(request.options); }
  }

  close(): void { this.dialogState.visible = false; }
  toggleMaximized(): void { this.dialogState.maximized = !this.dialogState.maximized; }
  setOffset(offsetX: number, offsetY: number): void { this.dialogState.offsetX = offsetX; this.dialogState.offsetY = offsetY; }
  setSize(width: number, height: number): void { this.dialogState.width = width; this.dialogState.height = height; }

  updateOptions(options: Partial<BlueprintPlannerOptions>): void {
    this.options = { ...this.options, ...options };
    runStorageEffect("planner-options", () => saveToLocalStorage(OPTIONS_KEY, toJS(this.options)));
  }

  getRequest(): BlueprintPlannerRequest {
    if (this.plan === null) throw new Error("请先计算产线规划。");
    return { plan: structuredClone(this.plan), options: toJS(this.options) };
  }
}
