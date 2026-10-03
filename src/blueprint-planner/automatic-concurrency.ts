export interface PlannerResourceHints {
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
}

export interface PlannerConcurrencySample {
  readonly at: number;
  readonly evaluations: number;
  readonly activeWorkers: number;
  readonly pendingVerifications: number;
  readonly lagMs: number;
  readonly pressure?: "nominal" | "fair" | "serious" | "critical";
}

/** 容量提示只给保守上限，不能解释为整机空闲 CPU 或可用内存。 */
export function plannerConcurrencyLimit(hints: PlannerResourceHints): number {
  const cores = Number.isSafeInteger(hints.hardwareConcurrency) && hints.hardwareConcurrency! > 0 ? hints.hardwareConcurrency! : 2;
  const memory = Number.isFinite(hints.deviceMemory) && hints.deviceMemory! > 0 ? hints.deviceMemory! : 4;
  return Math.max(1, Math.min(32, Math.floor(cores * 0.8) - 1, Math.floor(memory)));
}

/** 小步试探，以完整窗口吞吐决定保留；响应变差时快速收缩，冷却后允许重新探测。 */
export class PlannerAutomaticConcurrency {
  target = 1;
  private startedAt: number;
  private startedEvaluations: number;
  private busySamples = 0;
  private samples = 0;
  private baselineRate: number | null = null;
  private probing = false;
  private nextProbeAt = 0;
  private slowSamples = 0;

  constructor(readonly maximum: number, at: number, evaluations: number) {
    this.startedAt = at; this.startedEvaluations = evaluations;
  }

  private reset(sample: PlannerConcurrencySample): void {
    this.startedAt = sample.at; this.startedEvaluations = sample.evaluations;
    this.busySamples = 0; this.samples = 0;
  }

  observe(sample: PlannerConcurrencySample): number {
    const duration = sample.at - this.startedAt;
    // 验证积压由 Host 暂停领批；一次卡顿和验证队列均不代表 CPU 容量耗尽。
    this.slowSamples = sample.lagMs >= 100 ? this.slowSamples + 1 : 0;
    // AI-REMOVED 2026-10-03:
    // Reason: 瞬时卡顿与串行验证会反复刷新冷却，空闲机器被长期锁在单 Worker。
    // Trigger: Windows 真机并发在 0/1 间切换。Evidence: before-desktop-02 决策采样。
    // Replacement: 连续三次响应延迟或 CPU 压力收缩；验证限流位于 Host.claim。
    // Risk: 最多三个采样周期后响应持续卡顿。Human Review: Required
    // Original code:
    // if (sample.lagMs >= 100 || sample.pressure === "serious" || sample.pressure === "critical" || sample.pendingVerifications >= 2) {
    if (this.slowSamples >= 3 || sample.pressure === "serious" || sample.pressure === "critical") {
      this.target = Math.max(1, this.target - Math.max(1, Math.floor(this.target / 4)));
      this.probing = false; this.baselineRate = null; this.nextProbeAt = sample.at + 4_000; this.reset(sample);
      return this.target;
    }
    this.samples++;
    if (sample.activeWorkers >= this.target) this.busySamples++;
    if (duration < 4_000) return this.target;
    const rate = Math.max(0, sample.evaluations - this.startedEvaluations) / duration;
    const busy = this.busySamples >= this.samples * 0.75;
    if (this.probing && this.baselineRate !== null && rate < this.baselineRate * 1.05) {
      this.target = Math.max(1, this.target - 1);
      this.nextProbeAt = sample.at + 8_000;
    } else if (busy && rate > 0 && sample.lagMs < 100
      && sample.at >= this.nextProbeAt && this.target < this.maximum) {
      this.baselineRate = rate;
      this.target++;
      this.probing = true;
      this.reset(sample);
      return this.target;
    }
    this.probing = false; this.baselineRate = rate; this.reset(sample);
    return this.target;
  }
}

export function browserPlannerResources(): PlannerResourceHints {
  return typeof navigator === "undefined" ? {} : {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  };
}

/** 压力观察是可选信号；权限或平台不支持时继续用吞吐和事件循环延迟。 */
export function observePlannerPressure(update: (value: PlannerConcurrencySample["pressure"]) => void): () => void {
  type Observer = { observe(source: "cpu", options: { sampleInterval: number }): Promise<void>; disconnect(): void };
  const Constructor = (globalThis as unknown as { PressureObserver?: new (callback: (records: Array<{ state: PlannerConcurrencySample["pressure"] }>) => void) => Observer }).PressureObserver;
  if (!Constructor) return () => undefined;
  let stopped = false;
  let observer: Observer | undefined;
  try {
    observer = new Constructor(records => { if (!stopped) update(records.at(-1)?.state); });
    void observer.observe("cpu", { sampleInterval: 1000 }).catch(() => { observer?.disconnect(); });
  } catch { observer?.disconnect(); }
  return () => { stopped = true; observer?.disconnect(); };
}
