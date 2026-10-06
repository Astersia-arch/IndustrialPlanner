/**
 * 算力标定的跨模块契约。
 *
 * 2026-10-06（评审：模块隔离）：容量报告原先定义在 `src/blueprint-planner/capacity-calibration.ts`，
 * 却被 Domain 的动作契约（blueprint-planner-action.ts）与 Shared 的存储层（planner-capacity-storage.ts）
 * 反向引用，形成 Domain → Planner、Shared → Planner 的倒置依赖。契约下沉到 Domain 之后：
 * Planner 实现该契约，Shared 只按硬件签名持久化，App 只读契约类型。
 *
 * 说明：`.docs/common/项目模块隔离开原则发规范.md` 位于未初始化的私有子模块内，本次无法读到原文，
 * 因此这里按仓库既有结构（特性类型集中在 `src/domain/<特性>/types/`）与 AGENTS.md 的
 * 「跨模块调用通过 Domain 契约」放置，如需调整请以该规范为准。
 */

/** 容量测量的硬件提示；只用于与标定存档做签名匹配，不代表机器实际能力。 */
export interface PlannerResourceHints {
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  /**
   * 用户可覆盖的安全阀，只用于防止无界试探；它不是容量结论，也不代表机器实际能力。
   * 2026-10-06：此前这里用「核数×0.8-1」「核数-1」「内存/2GB」这类公式直接当上限，
   * 等价于写死常量，不同配置的机器会被误伤或浪费；现在容量一律由标定测量得出。
   */
  readonly safetyCeiling?: number;
}

/** 单个并发档位的实测吞吐；lagMs 是主线程事件循环延迟，用于识别"已到算力天花板"。 */
export interface PlannerCapacityPoint {
  readonly workers: number;
  readonly evaluations: number;
  readonly windowMs: number;
  readonly evaluationsPerSecond: number;
  /** 相对上一档的吞吐倍数；首档为 1。 */
  readonly gain: number;
  readonly lagMs: number;
}

/** 一次算力标定的结果：由 Planner 产生，按硬件签名持久化，并作为 App 的读取契约。 */
export interface PlannerCapacityReport {
  readonly measuredAt: number;
  readonly hardware: PlannerResourceHints;
  /** 保守容量提示，作为标定结果的下界参照。 */
  readonly conservativeLimit: number;
  readonly points: readonly PlannerCapacityPoint[];
  /** 标定得到的并发上限：吞吐膝盖点。 */
  readonly concurrentWorkers: number;
  /**
   * 验证并行度的**上限**（运行期按搜索占用动态分配实际并发）。
   *
   * 2026-10-06（评审 P2）：验证跑的是一次完整 dense 仿真，比布局生成重得多，且此前从未被测量或写入，
   * 于是产品里验证池恒为 1，"并行验证"名存实亡。仿真的并发能力不在容量标定测量范围内
   * （见 capacity-probe.ts 的说明：给仿真挂满通道会因内存争用测出假平台），
   * 因此这里按实测布局容量给定上限。
   *
   * 订正 2026-10-07：此前这个上限是"实测容量的一半、且不超过 8"（旧 deriveVerificationWorkers），
   * 实测证明该常量会让搜索等验证时空出来的 20 多个核无人使用，整机占用掉到 4%~8%；
   * 现在上限就是实测容量本身，实际并发由 planVerificationParallelism 与搜索动态分配。
   */
  readonly verificationWorkers?: number;
  /** 标定得到的 GPU 布线交叉点（路由边界格数）；未测得时为 undefined。 */
  readonly gpuCrossoverCells?: number;
  /** 实测到的 WebGPU 适配器，便于用户确认标定跑在哪块设备上。 */
  readonly adapter?: { readonly vendor?: string; readonly architecture?: string; readonly fallback?: boolean };
  readonly notes: readonly string[];
}

/** 按硬件签名保存的标定存档；签名不符即整份作废。 */
export interface PlannerStoredCapacity {
  readonly signature: string;
  readonly report: PlannerCapacityReport;
}
