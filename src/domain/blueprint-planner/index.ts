export type { BlueprintPlannerState } from "./blueprint-planner-state";
// 订正 2026-10-07（PR #34 评审）：理论面积口径被上游维护者否决——面积上界不再暴露给用户，
// 默认上界改为「设备面积 × 2」，界面上的理论占用标注随之移除。下面的导出已换为 planner-device-area；
// 原注释所指的「被 App（界面标注）与 Planner（默认上界）共用」中，App 侧用途已不存在。
// 理论面积口径是纯计算且被 App（界面标注）与 Planner（默认上界）共用，必须导出为值而非仅类型。
// AI-REMOVED 2026-10-07:
// Reason: 口径废弃，导出对象随之删除。
// Trigger: PR #34 评审（面积上界不应对用户暴露）。Evidence: planner-device-area.ts 的归档块。
// Replacement: 下方 planner-device-area 的 resolvePlannerDeviceArea / PLANNER_DEFAULT_AREA_DEVICE_MULTIPLE。
// Risk: Low。Human Review: Required
// Original code:
// export type { PlannerTheoreticalArea } from "./planner-theoretical-area";
// export { PLANNER_DEFAULT_AREA_LIMIT_MULTIPLE, resolvePlannerTheoreticalArea } from "./planner-theoretical-area";
export { PLANNER_DEFAULT_AREA_DEVICE_MULTIPLE, resolvePlannerDeviceArea } from "./planner-device-area";
export type { BlueprintPlannerAction } from "./blueprint-planner-action";
export type { BlueprintPlannerQuery } from "./blueprint-planner-query";
export type { BlueprintPlannerContract } from "./blueprint-planner-contract";
export type * from "./types/blueprint-planner-types";
export type * from "./types/planner-capacity-types";
export type * from "./types/planner-distributed-protocol";
// 协议常量是值而非类型；`export type *` 不导出它们，必须显式列出。
export {
  PLANNER_DISTRIBUTED_PROTOCOL_VERSION,
  PLANNER_LAN_UNIT_PAYLOAD_LIMIT_BYTES,
  PLANNER_NODE_HEARTBEAT_INTERVAL_MS,
  PLANNER_NODE_MISSED_HEARTBEATS,
} from "./types/planner-distributed-protocol";
