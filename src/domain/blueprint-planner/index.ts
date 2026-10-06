export type { BlueprintPlannerState } from "./blueprint-planner-state";
export type { PlannerTheoreticalArea } from "./planner-theoretical-area";
// 理论面积口径是纯计算且被 App（界面标注）与 Planner（默认上界）共用，必须导出为值而非仅类型。
export { PLANNER_DEFAULT_AREA_LIMIT_MULTIPLE, resolvePlannerTheoreticalArea } from "./planner-theoretical-area";
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
