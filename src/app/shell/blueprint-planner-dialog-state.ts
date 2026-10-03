import { makeAutoObservable, observable, toJS } from "mobx";
import type { BlueprintPlannerItemPolicy, BlueprintPlannerOptions, BlueprintPlannerProductionPlan, BlueprintPlannerRequest, BlueprintPlannerSupplyPolicy } from "@/domain/blueprint-planner";
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
    solidOutput: "auto", byproducts: "destroy", plantStartup: "preload", evaluationsPerRound: 500_000, concurrency: "auto",
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
      // AI-REMOVED 2026-10-03:
      // Reason: 浏览器并发统一自动调节，旧手填值不能限制恢复后的自动模式。
      // Trigger: 用户授权取消手填并发。Evidence: 默认选项及继续规划改用 auto。
      // Replacement: options.concurrency = "auto"。Risk: Low。Human Review: Required
      // Original code:
      // if (typeof saved.concurrency === "number" && Number.isSafeInteger(saved.concurrency)
      //   && saved.concurrency >= 1 && saved.concurrency <= 32) this.options = { ...this.options, concurrency: saved.concurrency };
      // AI-CORRECTION 2026-10-03：复选框关闭保存为 1；旧多 Worker 数字仍迁移为自动。
      if (saved.concurrency === 1) this.options = { ...this.options, concurrency: 1 };
    }
    makeAutoObservable(this, { plan: observable.ref }, { autoBind: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    runStorageEffect("planner-enabled", () => saveToLocalStorage(ENABLED_KEY, enabled));
    if (!enabled) this.close();
  }

  open(plan?: BlueprintPlannerProductionPlan, options?: BlueprintPlannerOptions): void {
    if (plan !== undefined) {
      this.plan = structuredClone(plan); this.viewTaskId = null;
      this.options = options ? toJS(options) : { ...this.options, itemPolicies: [] };
    }
    this.dialogState.visible = true;
  }

  selectTask(taskId: string | null, request?: BlueprintPlannerRequest): void {
    this.viewTaskId = taskId;
    if (taskId === null || !request) this.plan = null;
    if (request) { this.plan = structuredClone(request.plan); this.options = {
      ...structuredClone(request.options), concurrency: request.options.concurrency === 1 ? 1 : "auto",
    }; }
  }

  close(): void { this.dialogState.visible = false; }
  toggleMaximized(): void { this.dialogState.maximized = !this.dialogState.maximized; }
  setOffset(offsetX: number, offsetY: number): void { this.dialogState.offsetX = offsetX; this.dialogState.offsetY = offsetY; }
  setSize(width: number, height: number): void { this.dialogState.width = width; this.dialogState.height = height; }

  updateOptions(options: Partial<BlueprintPlannerOptions>): void {
    this.options = { ...this.options, ...options,
      concurrency: (options.concurrency ?? this.options.concurrency) === 1 ? 1 : "auto" };
    runStorageEffect("planner-options", () => saveToLocalStorage(OPTIONS_KEY, toJS(this.options)));
  }

  updateSupplyPolicy(policy: BlueprintPlannerSupplyPolicy): void {
    if (!this.plan || this.viewTaskId !== null) return;
    this.plan = { ...this.plan, supplyPolicies: [...(this.plan.supplyPolicies ?? []).filter(entry => entry.itemId !== policy.itemId), policy] };
  }

  updateItemPolicy(policy: BlueprintPlannerItemPolicy): void {
    if (!this.plan || this.viewTaskId !== null) return;
    this.options = { ...this.options, itemPolicies: [...(this.options.itemPolicies ?? []).filter(entry => entry.itemId !== policy.itemId), policy] };
  }

  getRequest(): BlueprintPlannerRequest {
    if (this.plan === null) throw new Error("请先计算产线规划。");
    return { plan: structuredClone(this.plan), options: toJS(this.options) };
  }
}
