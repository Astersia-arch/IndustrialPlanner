import type { BlueprintPlannerPhase, BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import type { PlannerCandidate } from "./candidate";
import type { PlannerSearchOptions, PlannerSearchStatistics } from "./search-types";
import type { PlannerRoutingMetrics } from "./routing-backend";
import type { PlannerGpuLayoutMetrics } from "./layout-backend";

export interface PlannerWorkerRequest {
  readonly id: number;
  readonly request: BlueprintPlannerRequest;
  readonly variant: number;
  readonly budgetMs: number | null;
  readonly search?: PlannerSearchOptions;
  readonly gpu?: boolean;
}

export type PlannerWorkerResponse =
  | { readonly id: number; readonly type: "progress"; readonly phase: BlueprintPlannerPhase; readonly message: string; readonly evaluations: number }
  | { readonly id: number; readonly type: "completed"; readonly candidate: PlannerCandidate; readonly routing?: PlannerRoutingMetrics; readonly layout?: PlannerGpuLayoutMetrics }
  | { readonly id: number; readonly type: "failed"; readonly kind: "candidate" | "timeout" | "fatal"; readonly message: string; readonly search?: PlannerSearchStatistics; readonly evaluations: number; readonly routing?: PlannerRoutingMetrics; readonly layout?: PlannerGpuLayoutMetrics };
