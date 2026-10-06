import type { GridPoint, GridRect } from "@/domain/shared/grid";
import type { PlannerRoutingGrid } from "./routing-grid";

export interface PlannerRoutingProblem {
  readonly grid: PlannerRoutingGrid;
  readonly bounds: GridRect;
  readonly start: GridPoint;
  readonly goal: GridPoint;
  readonly startDirection: number;
  readonly finalDirection: number;
  readonly kind: number;
  /**
   * 2026-10-06：合成探针用的起终点跨度。GPU 着色器不含启发式，只有 CPU 侧 A* 会用它做估价；
   * 生产 Router 不传该字段，因为它的估价直接由端口坐标算出。
   */
  readonly span?: number;
}

export interface PlannerRoutingMetrics {
  gpuAttempts: number;
  gpuAccepted: number;
  /** GPU 在对照模式下空手而归的次数；用于观察"反复尝试 GPU 却总是回退"。 */
  gpuMisses: number;
  cpuRoutes: number;
  pairedSamples: number;
  gpuMs: number;
  cpuMs: number;
  uploadedBytes: number;
  fallbackReason?: string;
}

/**
 * GPU 路线的运行边界。2026-10-06：这些值原先写死在 gpu-routing.ts（250ms 单次上限、1500ms 初始化、
 * 4096 格准入、512 格路径上限），不同机器/浏览器差异很大，会被误杀或浪费。
 * 现在由基准测试（capacity-calibration 的 GPU 探针）给出，未标定时退化为保守缺省。
 */
export interface PlannerGpuTuning {
  /** 单次 GPU 布线的墙钟上限；取实测 P90 的若干倍。 */
  readonly searchDeadlineMs: number;
  /** WebGPU 设备与流水线的初始化预算；取实测初始化耗时的若干倍。 */
  readonly initDeadlineMs: number;
  /** 允许交给 GPU 的最大网格格数；超出即走 CPU（实测 GPU 无优势的规模）。 */
  readonly maxBoundsCells: number;
  /** 结果缓冲能容纳的最大步数；低于实测最长路径。 */
  readonly maxPathSteps: number;
}

/**
 * 保守缺省：只在没有 GPU 标定结果时使用，故意取小，让未标定的机器先走 CPU 而不是被长超时拖住。
 */
export const DEFAULT_GPU_TUNING: PlannerGpuTuning = Object.freeze({
  searchDeadlineMs: 120,
  initDeadlineMs: 1_000,
  maxBoundsCells: 2_048,
  maxPathSteps: 384,
});

/** 由实测样本派生调参：超时取实测值的倍率，规模上限取实测"仍快于 CPU"的最大格数。 */
export function deriveGpuTuning(measurement: {
  readonly searchMsP90?: number;
  readonly initMs?: number;
  readonly maxProfitableCells?: number;
  readonly maxPathSteps?: number;
}, factor = 3): PlannerGpuTuning {
  return {
    searchDeadlineMs: clamp(Math.ceil((measurement.searchMsP90 ?? DEFAULT_GPU_TUNING.searchDeadlineMs) * factor), 16, 4_000),
    initDeadlineMs: clamp(Math.ceil((measurement.initMs ?? DEFAULT_GPU_TUNING.initDeadlineMs) * factor), 200, 10_000),
    maxBoundsCells: clamp(measurement.maxProfitableCells ?? DEFAULT_GPU_TUNING.maxBoundsCells, 256, 65_536),
    maxPathSteps: clamp(measurement.maxPathSteps ?? DEFAULT_GPU_TUNING.maxPathSteps, 64, 4_096),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

/** 2026-10-06：栅格分桶不再写死 256/1024/4096，按实际规模动态分桶。 */
export function routingBucketKey(cells: number): number {
  if (cells <= 0) return 64;
  return 2 ** Math.ceil(Math.log2(cells));
}

/** CPU 和 GPU 只提出路径，实体占用提交与生产验收仍由 Router / Host 负责。 */
export interface PlannerRoutingBackend {
  readonly tuning: PlannerGpuTuning;
  connect(problem: PlannerRoutingProblem, checkBudget: () => void, cpu: () => Promise<{ length: number; searchMs: number }>,
    validate: (cells: readonly GridPoint[]) => boolean, accept: (cells: readonly GridPoint[]) => boolean): Promise<number>;
}

/** 同一规模连续失败到该次数后先改走 CPU，避免 compare 模式每次空跑 GPU。 */
const GPU_FAILURE_LIMIT = 3;
/** 失败后的冷却时长；到期再给一次对照机会，机器或驱动变化仍能被发现。 */
const GPU_FAILURE_COOLDOWN_MS = 30_000;
/** 成功对照后的下次探测间隔。 */
const GPU_PROBE_INTERVAL_MS = 30_000;

interface PlannerRoutingBucket {
  samples: number; failures: number; cpu: number; gpu: number; nextProbe: number; uses: number;
}

/** 按图规模分别实测；短路由不会使大图永远失去探测机会。 */
export class PlannerRoutingPerformance {
  private readonly buckets = new Map<number, PlannerRoutingBucket>();

  choose(cells: number, now: number): "cpu" | "gpu" | "compare" {
    const bucket = this.buckets.get(routingBucketKey(cells));
    if (!bucket) return "compare";
    // 订正 2026-10-06（评审 P2）：GPU 空手而归原本完全不留痕，样本数永远到不了 3，
    // compare 模式因此每次都先空跑一遍 GPU 再回退 CPU（模拟连续失败时 6 次请求全部重复尝试 GPU）。
    // 现在连续失败到上限即进入冷却、先走 CPU，冷却到期再给一次对照机会。
    if (bucket.samples < 3) return bucket.failures >= GPU_FAILURE_LIMIT && now < bucket.nextProbe ? "cpu" : "compare";
    if (bucket.gpu < bucket.cpu * 0.9) return ++bucket.uses % 32 === 0 ? "compare" : "gpu";
    return now >= bucket.nextProbe ? "compare" : "cpu";
  }

  record(cells: number, cpuMs: number, gpuMs: number, now: number): void {
    const key = routingBucketKey(cells), previous = this.buckets.get(key);
    const samples = (previous?.samples ?? 0) + 1, weight = samples <= 3 ? 1 / samples : 0.5;
    this.buckets.set(key, { samples, failures: 0, cpu: (previous?.cpu ?? 0) * (1 - weight) + cpuMs * weight,
      gpu: (previous?.gpu ?? 0) * (1 - weight) + gpuMs * weight, nextProbe: now + GPU_PROBE_INTERVAL_MS, uses: previous?.uses ?? 0 });
  }

  /** GPU 在该规模空手而归：记一次失败并把下次对照推后，避免 compare 模式反复空跑。 */
  recordGpuFailure(cells: number, now: number): void {
    const key = routingBucketKey(cells), previous = this.buckets.get(key);
    this.buckets.set(key, { samples: previous?.samples ?? 0, failures: (previous?.failures ?? 0) + 1,
      cpu: previous?.cpu ?? 0, gpu: previous?.gpu ?? 0, nextProbe: now + GPU_FAILURE_COOLDOWN_MS, uses: previous?.uses ?? 0 });
  }

  /** 实测中 GPU 仍快于 CPU 的最大格数；供标定派生 tuning.maxBoundsCells。 */
  profitableCeiling(): number | undefined {
    let ceiling: number | undefined;
    for (const [key, bucket] of this.buckets) {
      if (bucket.samples > 0 && bucket.gpu < bucket.cpu * 0.9) ceiling = Math.max(ceiling ?? 0, key);
    }
    return ceiling;
  }
}
