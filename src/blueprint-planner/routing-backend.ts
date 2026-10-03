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
}

export interface PlannerRoutingMetrics {
  gpuAttempts: number;
  gpuAccepted: number;
  cpuRoutes: number;
  pairedSamples: number;
  gpuMs: number;
  cpuMs: number;
  uploadedBytes: number;
  fallbackReason?: string;
}

/** CPU 和 GPU 只提出路径，实体占用提交与生产验收仍由 Router / Host 负责。 */
export interface PlannerRoutingBackend {
  connect(problem: PlannerRoutingProblem, checkBudget: () => void, cpu: () => Promise<{ length: number; searchMs: number }>,
    validate: (cells: readonly GridPoint[]) => boolean, accept: (cells: readonly GridPoint[]) => boolean): Promise<number>;
}

/** 按图规模分别实测；短路由不会使大图永远失去探测机会。 */
export class PlannerRoutingPerformance {
  private readonly buckets = new Map<number, { samples: number; cpu: number; gpu: number; nextProbe: number; uses: number }>();

  choose(cells: number, now: number): "cpu" | "gpu" | "compare" {
    const bucket = this.buckets.get(this.key(cells));
    if (!bucket || bucket.samples < 3) return "compare";
    if (bucket.gpu < bucket.cpu * 0.9) return ++bucket.uses % 32 === 0 ? "compare" : "gpu";
    return now >= bucket.nextProbe ? "compare" : "cpu";
  }

  record(cells: number, cpuMs: number, gpuMs: number, now: number): void {
    const key = this.key(cells), previous = this.buckets.get(key);
    const samples = (previous?.samples ?? 0) + 1, weight = samples <= 3 ? 1 / samples : 0.5;
    this.buckets.set(key, { samples, cpu: (previous?.cpu ?? 0) * (1 - weight) + cpuMs * weight,
      gpu: (previous?.gpu ?? 0) * (1 - weight) + gpuMs * weight, nextProbe: now + 30_000, uses: previous?.uses ?? 0 });
  }

  private key(cells: number): number { return cells <= 256 ? 256 : cells <= 1024 ? 1024 : 4096; }
}
