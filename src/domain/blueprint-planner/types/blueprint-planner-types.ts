import type { BlueprintDocument } from "../../document/blueprint-document";
import type { GridPoint, GridEdge } from "../../shared/grid";

export interface BlueprintPlannerFlow {
  readonly itemId: string;
  readonly perMinute: number;
}

export interface BlueprintPlannerRecipePlan {
  readonly recipeId: string;
  readonly cyclesPerMinute: number;
  readonly deviceCount: number;
  readonly inputs: readonly BlueprintPlannerFlow[];
  readonly outputs: readonly BlueprintPlannerFlow[];
  readonly runningInputs: readonly BlueprintPlannerFlow[];
}

export interface BlueprintPlannerProductionPlan {
  readonly name: string;
  readonly sourceBaseId: string;
  readonly targets: readonly BlueprintPlannerFlow[];
  readonly recipes: readonly BlueprintPlannerRecipePlan[];
  readonly externalSupplies: readonly BlueprintPlannerFlow[];
  readonly infiniteItemIds: readonly string[];
  readonly byproductItemIds: readonly string[];
  readonly containsModules: boolean;
  readonly unresolvedPerMinute: number;
  readonly activeActivityIds: readonly string[];
}

export interface BlueprintPlannerOptions {
  readonly solidSupply: "external" | "warehouse";
  readonly fluidSupply: "external" | "conduit";
  readonly warehouseBus: "straight" | "free";
  readonly solidOutput: "warehouse" | "stash" | "auto";
  readonly byproducts: "destroy" | "output";
  readonly plantStartup: "preload" | "warehouse";
  // AI-REMOVED 2026-09-30:
  // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
  // Trigger: 用户批准本轮接口与交互调整。
  // Evidence: 原实现使用时间截止或关闭任务面板。
  // Replacement: src/domain/blueprint-planner/types/blueprint-planner-types.ts
  // Risk: Low。Human Review: Required
  // Original code:
  //   readonly budgetMs: number;

  readonly evaluationsPerRound: number;
  readonly concurrency?: number;
}

export interface BlueprintPlannerRequest {
  readonly plan: BlueprintPlannerProductionPlan;
  readonly options: BlueprintPlannerOptions;
}

export type BlueprintPlannerTaskStatus =
  | "running"
  | "waiting"
  | "saving"
  | "completed"
  | "cancelled"
  | "failed"
  | "save-failed";

export type BlueprintPlannerPhase =
  | "preparing"
  | "layout"
  | "routing"
  | "verification"
  | "optimization"
  | "saving";

export interface BlueprintPlannerAreaPoint {
  readonly evaluatedProposals: number;
  readonly bestArea: number;
}

export interface BlueprintPlannerProgress {
  readonly taskId: string;
  readonly status: BlueprintPlannerTaskStatus;
  readonly phase: BlueprintPlannerPhase;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly estimatedProgress: number | null;
  readonly evaluatedProposals: number;
  readonly roundEvaluatedProposals: number;
  readonly candidateCount: number;
  readonly validatedCandidateCount: number;
  readonly bestArea: number | null;
  readonly areaHistory?: readonly BlueprintPlannerAreaPoint[];
  readonly message: string | null;
}

export interface BlueprintPlannerMetrics {
  readonly width: number;
  readonly height: number;
  readonly area: number;
  readonly entityCount: number;
  readonly productionDeviceCount: number;
  readonly gasDiffuserCount: number;
  readonly additionalGasDiffuserCount: number;
  readonly score: number;
}

export interface BlueprintPlannerConnection {
  readonly itemId: string;
  readonly kind: "belt" | "pipe";
  readonly direction: "input" | "output";
  readonly position: GridPoint;
  readonly edge: GridEdge;
  readonly perMinute: number;
}

export interface BlueprintPlannerResult {
  readonly taskId: string;
  readonly blueprint: BlueprintDocument;
  readonly folderId: string | null;
  readonly metrics: BlueprintPlannerMetrics;
  readonly connections: readonly BlueprintPlannerConnection[];
  readonly measuredOutputs: readonly BlueprintPlannerFlow[];
  readonly warmupSeconds: number;
  readonly observationSeconds: number;
  readonly elapsedMs: number;
}

/** 可移植任务；checkpoint 仅由规划器解析，界面和同步模块不解释搜索内部状态。 */
export interface BlueprintPlannerTaskFile {
  readonly formatVersion: 1;
  readonly algorithmVersion: string;
  readonly taskId: string;
  readonly request: BlueprintPlannerRequest;
  readonly progress: BlueprintPlannerProgress;
  readonly checkpoint: unknown;
}
