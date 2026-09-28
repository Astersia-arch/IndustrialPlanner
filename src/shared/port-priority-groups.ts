import type { RegistryQuery } from "@/domain/registry/registry-query";
import type {
  DefaultPortPriority,
  DefaultPortPriorityConnection,
} from "@/domain/registry/types/default-port-priority";
import type { DirectPortConnection } from "./port-connections";

export const PORT_PRIORITY_GROUP_MIN = 1;
export const PORT_PRIORITY_GROUP_MAX = 9;
export const DEFAULT_PORT_PRIORITY_GROUP = 5;

export const CUSTOM_PORT_PRIORITY_GROUPS_CONFIG_KEY = "customPortPriorityGroups";
export const PORT_PRIORITY_GROUP_OVERRIDES_CONFIG_KEY = "portPriorityGroups";

export const DEFAULT_PORT_PRIORITY_PROBLEM_TITLE = "默认端口存在优先级";
export const DEFAULT_PORT_PRIORITY_PROBLEM_DESCRIPTION = "您摆出的这个设备组合，会导致本身在游戏内的默认端口优先级发生变化。";

/** 只组装 Query 上下文，不持有设备 ID 或游戏规则。 */
export function collectDefaultPortPriorityGroups(
  devices: readonly { readonly id: string; readonly definitionId: string; readonly placementOrder: number }[],
  connections: readonly DirectPortConnection[],
  queries: RegistryQuery,
): ReadonlyMap<string, readonly DefaultPortPriority[]> {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const neighbors = new Map<string, DefaultPortPriorityConnection[]>();
  for (const connection of connections) {
    for (const [port, neighborPort] of [
      [connection.sourcePort, connection.targetPort],
      [connection.targetPort, connection.sourcePort],
    ] as const) {
      const neighbor = deviceById.get(neighborPort.deviceId);
      if (neighbor === undefined) continue;
      const entries = neighbors.get(port.deviceId) ?? [];
      entries.push({
        portGroupId: port.portGroupId,
        portId: port.portDefinitionId,
        neighborDefinitionId: neighbor.definitionId,
        neighborPlacementOrder: neighbor.placementOrder,
      });
      neighbors.set(port.deviceId, entries);
    }
  }
  const result = new Map<string, readonly DefaultPortPriority[]>();
  for (const device of devices) {
    const defaults = queries.resolveDefaultPortPriorityGroups({
      definitionId: device.definitionId,
      connections: neighbors.get(device.id) ?? [],
    });
    if (defaults !== null) result.set(device.id, defaults);
  }
  return result;
}

export function resolvePortPriorityGroupOverrideKey(
  portGroupId: string,
  portId: string,
): string {
  return `${portGroupId}:${portId}`;
}

export function isCustomPortPriorityGroupsEnabled(
  config: Readonly<Record<string, unknown>>,
): boolean {
  return config[CUSTOM_PORT_PRIORITY_GROUPS_CONFIG_KEY] === true;
}

export function normalizePortPriorityGroup(value: unknown): number {
  if (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= PORT_PRIORITY_GROUP_MIN
    && value <= PORT_PRIORITY_GROUP_MAX
  ) {
    return value;
  }

  return DEFAULT_PORT_PRIORITY_GROUP;
}

export function readPortPriorityGroupOverrides(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const raw = config[PORT_PRIORITY_GROUP_OVERRIDES_CONFIG_KEY];

  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as Readonly<Record<string, unknown>>;
}
