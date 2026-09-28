/** 已由调用方确认几何、方向和运输类型匹配的直接端口连接。 */
export interface DefaultPortPriorityConnection {
  readonly portGroupId: string;
  readonly portId: string;
  readonly neighborDefinitionId: string;
  readonly neighborPlacementOrder: number;
}

export interface DefaultPortPriorityContext {
  readonly definitionId: string;
  readonly connections: readonly DefaultPortPriorityConnection[];
}

/** 组合规则改变的默认值；未列出的端口继续使用设备定义默认值。 */
export interface DefaultPortPriority {
  readonly portGroupId: string;
  readonly portId: string;
  readonly priorityGroup: number;
}
