import type { PlannerStoredCapacity } from "@/domain/blueprint-planner";

const STORAGE_KEY = "v3-planner-capacity";

/** 标定结果按机器签名分开保存：不同配置的机器不应互相覆盖容量结论。 */
export function plannerCapacitySignature(hardwareConcurrency: number | undefined, deviceMemory: number | undefined): string {
  return `${hardwareConcurrency ?? 0}c/${deviceMemory ?? 0}g`;
}

// 2026-10-06（评审：模块隔离）：PlannerStoredCapacity 已移动到 Domain，此处不再定义。

/**
 * 本机容量签名。
 * 2026-10-06（评审：模块隔离）：签名由存储层自己从浏览器环境取得，App 因此不必再直接引用
 * Planner 内部的 browserPlannerResources。已知局限：deviceMemory 按规范上限为 8，
 * 所以签名只能区分"低于 8GB 的具体档位"与"≥8GB"，同核数且都不小于 8GB 的两台机器仍会撞签名。
 */
export function localPlannerCapacitySignature(): string {
  if (typeof navigator === "undefined") return plannerCapacitySignature(undefined, undefined);
  return plannerCapacitySignature(navigator.hardwareConcurrency,
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
}

export function savePlannerCapacity(capacity: PlannerStoredCapacity): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(capacity)); } catch { /* 隐私模式或配额不足时静默降级 */ }
}

export function loadPlannerCapacity(): PlannerStoredCapacity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PlannerStoredCapacity>;
    if (typeof parsed.signature !== "string" || !parsed.report || !Number.isSafeInteger(parsed.report.concurrentWorkers)) return null;
    return { signature: parsed.signature, report: parsed.report };
  } catch { return null; }
}

export function clearPlannerCapacity(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 同上 */ }
}

/**
 * 读取本机可用的并发上限：只有签名一致（同一台机器/同一浏览器配置）时才采用，
 * 避免把 A 机器的标定结论套到 B 机器上。
 */
export function resolveCalibratedWorkers(signature: string): number | undefined {
  const stored = loadPlannerCapacity();
  if (stored === null || stored.signature !== signature) return undefined;
  return stored.report.concurrentWorkers;
}
