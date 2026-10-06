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

/** 按需供料规则；数量由环境布局和实际设备消耗共同确定。 */
export type BlueprintPlannerSupplyPolicy = { readonly itemId: string } & (
  | { readonly source: "external" }
  | { readonly source: "production"; readonly recipeId: string }
);

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
  readonly supplyPolicies?: readonly BlueprintPlannerSupplyPolicy[];
}

/** 逐物品的物流接入和剩余处理；不改变生产方案中的物料来源。 */
export interface BlueprintPlannerItemPolicy {
  readonly itemId: string;
  readonly supply?: "external" | "warehouse" | "conduit";
  readonly output?: "auto" | "warehouse" | "stash";
  readonly byproducts?: "destroy" | "output";
}

export interface BlueprintPlannerOptions {
  readonly itemPolicies?: readonly BlueprintPlannerItemPolicy[];
  readonly solidSupply: "external" | "warehouse";
  readonly fluidSupply: "external" | "conduit";
  readonly warehouseBus: "straight" | "corner" | "u-shaped";
  readonly solidOutput: "warehouse" | "stash" | "auto";
  readonly byproducts: "destroy" | "output";
  readonly plantStartup: "preload" | "warehouse";
  /** 转化设备耗材自循环的启动方式；旧任务缺省为拒绝启动。 */
  readonly converterStartup?: "manual" | "tank" | "reject";
  // AI-REMOVED 2026-09-30:
  // Reason: 改为提案预算与真实累计计数，预览保留任务窗口。
  // Trigger: 用户批准本轮接口与交互调整。
  // Evidence: 原实现使用时间截止或关闭任务面板。
  // Replacement: src/domain/blueprint-planner/types/blueprint-planner-types.ts
  // Risk: Low。Human Review: Required
  // Original code:
  //   readonly budgetMs: number;

  readonly evaluationsPerRound: number;
  readonly concurrency?: number | "auto";
  // AI-REMOVED 2026-10-06:
  // Reason: 机型容量被写进可移植的任务文件是错位的，而且这两个字段从未被写入过：
  //         calibratedWorkers / calibratedVerifiers 全仓库只有读取点，没有写入点，
  //         于是"任务内记录优先"实际恒为空，验证并行度恒等于保守起点 1。
  // Trigger: 评审 P2（产品入口的并行验证没有接通）。
  // Evidence: v3 全仓库 grep 只有 blueprint-planner-host.ts 两处读取与类型声明，无任何赋值。
  // Replacement: 容量结论只来自本机标定（shared/storage/planner-capacity-storage.ts，按硬件签名隔离）；
  //              验证并行度由 capacity-calibration.ts 的 deriveVerificationWorkers 从实测并发派生。
  // Risk: 旧任务文件里若带有这两个键会成为无用的多余字段，解析不受影响（未做校验）。
  // Human Review: Required
  //
  // Original code:
  // /**
  //  * 2026-10-06：算力基准测试标定出的并发上限（见 capacity-calibration.ts）。
  //  * 浏览器不暴露 CPU/GPU 占用百分比，无法直接闭环控制占用率，因此先把实测吞吐曲线的膝盖点固化下来，
  //  * 调度策略在该上限内自适应；未标定时不写入此字段。
  //  */
  // readonly calibratedWorkers?: number;
  // /** 基准测试标定出的并行验证容量；未标定时运行时会从保守起点自适应。 */
  // readonly calibratedVerifiers?: number;
}

export interface BlueprintPlannerRequest {
  /** 原图快照与已声明边界；plan 是识别得到的产率基线，不用于重建原图设备。 */
  readonly blueprintSource?: BlueprintPlannerBlueprintInput;
  readonly plan: BlueprintPlannerProductionPlan;
  readonly options: BlueprintPlannerOptions;
}

export interface BlueprintPlannerBlueprintBoundary {
  readonly entityId: string;
  readonly portGroupId: string;
  readonly portId: string;
  readonly direction: "input" | "output";
  readonly kind: "port" | "facility";
  readonly itemId: string | null;
}

export interface BlueprintPlannerBlueprintInput {
  readonly blueprint: BlueprintDocument;
  readonly boundaries: readonly BlueprintPlannerBlueprintBoundary[];
  readonly activeActivityIds: readonly string[];
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
  readonly activeWorkerCount?: number;
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
