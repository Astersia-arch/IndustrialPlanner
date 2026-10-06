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
  // 订正 2026-10-07（合并上游 0cca0f89）：上面这条注释所描述的字段已被删除，
  // 其唯一消费者 plannerProbeCeiling 随上游重写自动并发模块一并取消。
  // AI-REMOVED 2026-10-07:
  // Reason: 上游重写 automatic-concurrency 后不再存在 plannerProbeCeiling / PLANNER_SAFETY_CEILING，
  //         本字段既无生产者也无消费者，保留会形成第二条容量口径。
  // Trigger: 合并上游 0cca0f89 的并发调度重构（用户确认"以官方结构为准"）。
  // Evidence: 全仓检索 safetyCeiling 仅剩本文件定义处，无任何读写方。
  // Replacement: 上限由 plannerConcurrencyCeiling(hints, 实测容量) 给出，见 blueprint-planner/automatic-concurrency.ts。
  // Risk: Low（字段此前已无生产者）。Human Review: Required
  //
  // Original code:
  // readonly safetyCeiling?: number;
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
  // 订正 2026-10-07（合并上游 0cca0f89）：上面这条注释末句描述的 planVerificationParallelism
  // 已随上游的共享额度验证调度作废，运行期不再按本字段分配验证并发；本字段保留为标定报告的一部分，
  // 仅用于展示与人工核对，不再是运行期输入。
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
