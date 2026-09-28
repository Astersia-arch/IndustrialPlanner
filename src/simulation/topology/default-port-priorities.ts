import type { WorldDocument } from "@/domain/document/world-document";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import {
  collectDefaultPortPriorityGroups,
  isCustomPortPriorityGroupsEnabled,
} from "@/shared/port-priority-groups";
import type {
  CompiledSimulationDevice,
  CompiledSimulationPhysicalConnection,
  CompiledSimulationPort,
} from "../contracts";

/** 在连接确定后补入默认值；用户覆盖已在设备编译阶段生效，保持其更高优先权。 */
export function applyDefaultPortPriorities(options: {
  readonly document: WorldDocument;
  readonly registry: RegistryContract;
  readonly deviceOrder: readonly string[];
  readonly devices: Record<string, CompiledSimulationDevice>;
  readonly ports: Record<string, CompiledSimulationPort>;
  readonly connections: readonly CompiledSimulationPhysicalConnection[];
}): void {
  const defaults = collectDefaultPortPriorityGroups(
    options.deviceOrder.map((id, placementOrder) => ({
      id, definitionId: options.devices[id]!.definitionId, placementOrder,
    })),
    options.connections.flatMap((connection) => {
      const sourcePort = options.ports[connection.sourcePortId];
      const targetPort = options.ports[connection.targetPortId];
      return sourcePort === undefined || targetPort === undefined ? [] : [{ sourcePort, targetPort }];
    }),
    options.registry.queries,
  );
  for (const [deviceId, priorities] of defaults) {
    const device = options.devices[deviceId]!;
    const entity = device.sourceEntityId === null ? undefined : options.document.entities[device.sourceEntityId];
    if (entity === undefined || isCustomPortPriorityGroupsEnabled(entity.config)) continue;
    const definition = options.registry.queries.findEntityDefinition(device.definitionId);
    const routing = { ...device.routing };
    for (const priority of priorities) {
      const groupIndex = definition?.portGroups.findIndex((group) => group.id === priority.portGroupId) ?? -1;
      const portIndex = definition?.portGroups[groupIndex]?.ports.findIndex((port) => port.id === priority.portId) ?? -1;
      // 现有蓝图与规划器的直接端口配置同样属于显式覆盖。
      if (entity.config[`portGroups[${groupIndex}].ports[${portIndex}].priorityGroup`] !== undefined) continue;
      const routingKey = `${priority.portGroupId}.${priority.portId}`;
      const entry = routing[routingKey];
      if (entry !== undefined) routing[routingKey] = { ...entry, priorityGroup: priority.priorityGroup };
      for (const portId of device.portIds) {
        const port = options.ports[portId];
        if (port?.portGroupId === priority.portGroupId && port.portDefinitionId === priority.portId) {
          options.ports[portId] = { ...port, priorityGroup: priority.priorityGroup };
        }
      }
    }
    options.devices[deviceId] = { ...device, routing };
  }
}
