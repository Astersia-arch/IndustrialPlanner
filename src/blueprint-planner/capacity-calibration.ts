import type { BlueprintPlannerRequest, PlannerCapacityPoint, PlannerCapacityReport,
  PlannerResourceHints } from "@/domain/blueprint-planner";
import type { SimulationEngineKind } from "@/domain/simulation";
import { plannerProbeCeiling, PLANNER_SAFETY_CEILING } from "@/blueprint-planner/automatic-concurrency";
import { pickPlateau, stepUpThroughput } from "./capacity-growth";
import type { PlannerGpuCrossoverReport } from "./gpu-crossover";

// 2026-10-06（评审：模块隔离）：PlannerCapacityPoint / PlannerCapacityReport / PlannerResourceHints
// 已移动到 @/domain/blueprint-planner/types/planner-capacity-types.ts（契约下沉到 Domain），
// 原定义不在此处保留副本，避免出现两个真相来源。

/** 一个请求在某个并发档位下的测量结果，由调用方注入具体执行方式（浏览器 Worker 或 Node Worker）。 */
export interface PlannerCapacityProbe {
  readonly workers: number;
  readonly windowMs: number;
  readonly evaluations: number;
  readonly lagMs: number;
}

export interface PlannerCapacityProbeOptions {
  readonly request: BlueprintPlannerRequest;
  readonly engineKind: SimulationEngineKind;
  readonly workers: number;
  readonly windowMs: number;
  readonly evaluationsPerWindow: number;
  readonly signal?: AbortSignal;
}

// PlannerCapacityReport 已移动到 Domain（见文件头说明），此处不再定义。
// 标定选项仍留在 Planner：它引用 GPU 交叉点报告等实现细节。
export interface PlannerCapacityCalibrationOptions {
  readonly request: BlueprintPlannerRequest;
  readonly engineKind: SimulationEngineKind;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly onProgress?: (message: string) => void;
  readonly resourceHints?: PlannerResourceHints;
  /** 逐档窗口时长；默认 4 秒，与调度策略的观测窗口一致。 */
  readonly windowMs?: number;
  /** 每档派发的提案数；过小会让吞吐测量被调度开销淹没。 */
  readonly evaluationsPerWindow?: number;
  /** 最大探测档位数，防止在超大核心数机器上跑太久。 */
  readonly maxLevels?: number;
  /**
   * 2026-10-06：GPU 布线交叉点测量。只有具备真实 WebGPU 的调用方（浏览器 Host）会传入；
   * 未传入时跳过，报告里 `gpuCrossoverCells` 保持 undefined。
   */
  readonly measureGpuCrossover?: (onProgress?: (message: string) => void, signal?: AbortSignal) => Promise<PlannerGpuCrossoverReport>;
  readonly signal?: AbortSignal;
}

const DEFAULT_WINDOW_MS = 4_000;
const DEFAULT_EVALUATIONS_PER_WINDOW = 20_000;
const DEFAULT_MAX_LEVELS = 6;
/** 吞吐增益低于该值即认为已到膝盖点，再增加并发不划算。 */
const KNEE_GAIN = 1.1;
/**
 * 验证并行度的资源上限（不是机型容量结论）：每个验证通道都要起一份 dense 仿真，
 * 这里按"单通道内存量级"设政策上限，避免在内存紧张的机器上把仿真堆到换页。
 */
const VERIFICATION_PARALLELISM_CAP = 8;

/**
 * 由实测布局并发上限派生验证并行度：验证单通道更重，取一半作为起点，至少 1、至多
 * VERIFICATION_PARALLELISM_CAP。显式覆盖（任务记录或 Host 选项）优先于本派生的值。
 */
export function deriveVerificationWorkers(concurrentWorkers: number): number {
  const measured = Number.isSafeInteger(concurrentWorkers) && concurrentWorkers >= 1 ? concurrentWorkers : 1;
  return Math.max(1, Math.min(VERIFICATION_PARALLELISM_CAP, Math.floor(measured / 2)));
}

/**
 * 2026-10-06：浏览器不暴露 CPU/GPU 占用百分比，无法直接闭环控制占用率。
 * 因此先做一次基准测试量出「并发数 → 实测吞吐」曲线，取膝盖点作为并发上限，
 * 之后仍由既有调度策略在该上限内自适应（爬升按剩余空间分配、压力时相对退让）。
 */
export async function calibratePlannerCapacity(probe: (options: PlannerCapacityProbeOptions) => Promise<PlannerCapacityProbe>,
  options: PlannerCapacityCalibrationOptions): Promise<PlannerCapacityReport> {
  const hints = options.resourceHints ?? {};
  const conservativeLimit = plannerProbeCeiling(hints);
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const evaluationsPerWindow = options.evaluationsPerWindow ?? DEFAULT_EVALUATIONS_PER_WINDOW;
  const notes: string[] = [];
  const estimatedMinutes = Math.max(1, Math.ceil((options.maxLevels ?? DEFAULT_MAX_LEVELS) * windowMs / 60_000));
  const agreed = await options.confirm(`基准测试将从保守并发开始逐档上探，约需 ${estimatedMinutes} 分钟，`
    + `期间本机 CPU 会被占满。测试只读取算力，不修改生产方案与蓝图。是否继续？`);
  if (!agreed) throw new Error("用户取消算力基准测试。");

  const points: PlannerCapacityPoint[] = [];
  // 2026-10-06：改为"从保守起点按档上探、增益不足即停"，上限由机器实测给出，
  // 不再用「核数×系数」这类公式预设档位数量或容量结论。
  const growth = await stepUpThroughput(async workers => {
    const sample = await probe({ request: options.request, engineKind: options.engineKind, workers,
      windowMs, evaluationsPerWindow, signal: options.signal });
    const evaluationsPerSecond = sample.windowMs > 0 ? sample.evaluations / (sample.windowMs / 1000) : 0;
    points.push({ workers, evaluations: sample.evaluations, windowMs: sample.windowMs, evaluationsPerSecond,
      gain: 1, lagMs: sample.lagMs });
    return { throughput: evaluationsPerSecond };
  }, { start: 1, ceiling: Math.max(1, conservativeLimit > 1 ? conservativeLimit : PLANNER_SAFETY_CEILING),
    minGain: KNEE_GAIN, maxLevels: options.maxLevels ?? DEFAULT_MAX_LEVELS, signal: options.signal, onProgress: options.onProgress });
  // 增益按最终序列回填，保持报告自洽。
  for (let index = 0; index < points.length; index++) {
    const previous = points[index - 1];
    (points[index] as { gain: number }).gain = previous && previous.evaluationsPerSecond > 0
      ? points[index]!.evaluationsPerSecond / previous.evaluationsPerSecond : 1;
  }
  notes.push(growth.reason);
  // 订正 2026-10-06（评审 P1）：没有任何有效吞吐样本时必须拒绝本次标定。
  // 原实现把"全 0 曲线"读成"2 档增益仅 1.00×"，照样落盘 concurrentWorkers = 1；
  // 而并发起点改为标定值之后，这个 1 会成为运行时起点，等于把整轮规划钉在单通道。
  const measured = points.filter(point => point.evaluationsPerSecond > 0);
  if (!measured.length) throw new Error("算力基准测试没有取得任何有效吞吐样本（Worker 未回报已完成的评估），已丢弃本次标定结果。");
  // 平台点必须落在实测到吞吐的档位上，否则取实测最高的一档，避免采信无效档位。
  const plateau = points.find(point => point.workers === growth.best);
  const concurrentWorkers = plateau !== undefined && plateau.evaluationsPerSecond > 0 ? growth.best
    : measured.reduce((best, point) => point.evaluationsPerSecond > best.evaluationsPerSecond ? point : best, measured[0]!).workers;
  if (concurrentWorkers !== growth.best) notes.push(`平台档位 ${growth.best} 没有有效吞吐样本，改用实测最高的 ${concurrentWorkers} 档。`);
  const over = points.find(point => point.lagMs >= 100);
  if (over) notes.push(`${over.workers} 通道时主线程延迟 ${Math.round(over.lagMs)}ms，需关注交互流畅度。`);
  // 2026-10-06：布局并发测完之后再测 GPU 布线交叉点。GPU 只在准入规模之内参与，
  // 因此它的交叉规模必须独立测量，不能由"GPU 已经跑过的那些大图"反推。
  let gpuCrossoverCells: number | undefined;
  let reportAdapter: PlannerCapacityReport["adapter"];
  if (options.measureGpuCrossover) {
    try {
      const crossover = await options.measureGpuCrossover(options.onProgress, options.signal);
      gpuCrossoverCells = crossover.maxProfitableCells;
      reportAdapter = crossover.adapter;
      notes.push(...crossover.notes);
    } catch (error) {
      // GPU 交叉点测不到不能影响已经得到的并发容量结论。
      notes.push(`GPU 交叉点测量未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { measuredAt: Date.now(), hardware: hints, conservativeLimit, points, concurrentWorkers,
    verificationWorkers: deriveVerificationWorkers(concurrentWorkers),
    ...(gpuCrossoverCells === undefined ? {} : { gpuCrossoverCells }),
    ...(reportAdapter === undefined ? {} : { adapter: reportAdapter }), notes };
}

/** 由吞吐曲线取膝盖点；导出供离线报告与测试复用。 */
export function capacityKnee(points: readonly PlannerCapacityPoint[], fallback: number): number {
  return pickPlateau(points.map(point => ({ value: point.workers, throughput: point.evaluationsPerSecond, gain: point.gain })),
    fallback, KNEE_GAIN).best;
}
