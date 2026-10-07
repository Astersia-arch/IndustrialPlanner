import type { GridRotation } from "@/domain/shared/grid";

/** 数值快照只供批量搜索使用；候选必须回到 CompactLayoutSearch 完整校验。 */
export interface PlannerLayoutBatch {
  readonly chains: number;
  /** 节点数、边数、宽、高、每链步数、随机种子、温度、直线存取线、连通评分。 */
  readonly parameters: Int32Array;
  /** 每节点四个朝向，每朝向 40 个整数；边同样使用 40 个整数。 */
  readonly geometry: Int32Array;
  readonly edges: Int32Array;
  readonly overlaps: Int32Array;
  readonly poses: Int32Array;
}

export interface PlannerLayoutBatchResult {
  readonly evaluations: number;
  readonly kernelMs: number;
  readonly poses: readonly (readonly { x: number; y: number; rotation: GridRotation }[])[];
}

export interface PlannerLayoutBackend {
  search(input: PlannerLayoutBatch): Promise<PlannerLayoutBatchResult | null>;
}

export interface PlannerGpuLayoutMetrics {
  batches: number;
  evaluations: number;
  kernelMs: number;
  wallMs: number;
  uploadedBytes: number;
  fallbackReason?: string;
}

/** 32 条独立链保留搜索深度；限制单次内核工作量，避免长命令拖住桌面和取消。 */
export function plannerLayoutBatchSize(nodes: number, cells: number, budget: number): { chains: number; steps: number } | null {
  if (!Number.isSafeInteger(nodes) || nodes < 1 || nodes > 64 || !Number.isSafeInteger(cells) || cells < 1 || cells > 1024
    || !Number.isSafeInteger(budget) || budget < 32) return null;
  const chains = Math.min(32, Math.floor(budget / 16));
  const steps = Math.min(625, Math.floor(budget / chains), Math.max(16, Math.floor(8_000_000 / (nodes * cells))));
  return { chains, steps };
}
