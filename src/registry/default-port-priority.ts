import type { EntityDefinition } from "@/domain/registry/types/entity-definition";
import type {
  DefaultPortPriority,
  DefaultPortPriorityContext,
} from "@/domain/registry/types/default-port-priority";
import { LOGISTICS_DEFINITION_ID_BY_KIND_AND_ROLE } from "./logistics-definition-ids";

const belt = LOGISTICS_DEFINITION_ID_BY_KIND_AND_ROLE.belt;
const pipe = LOGISTICS_DEFINITION_ID_BY_KIND_AND_ROLE.pipe;

/** 设备身份与游戏组合规则均归 Registry；调用者只提供直接连接事实。 */
export function resolveDefaultPortPriorityGroups(
  definition: EntityDefinition | undefined,
  context: DefaultPortPriorityContext,
): readonly DefaultPortPriority[] | null {
  if (definition === undefined) return null;
  const inputSplitterId = definition.id === "storager_1" || definition.id === belt.converger
    ? belt.splitter
    : definition.id === "udpipe_loader_2" || definition.id === pipe.converger
      ? pipe.splitter
      : null;
  const outputConvergerId = definition.id === "storager_1"
    ? belt.converger
    : definition.id === "udpipe_unloader_2"
      ? pipe.converger
      : null;
  if (inputSplitterId === null && outputConvergerId === null) return null;

  const result: DefaultPortPriority[] = [];
  const inputPorts = definition.portGroups
    .filter((group) => group.direction === "input")
    .flatMap((group) => group.ports.map((port) => ({ portGroupId: group.id, portId: port.id })));
  const inputKeys = new Set(inputPorts.map((port) => `${port.portGroupId}:${port.portId}`));
  const upstream = context.connections.filter((connection) =>
    inputKeys.has(`${connection.portGroupId}:${connection.portId}`));
  const splitterKeys = new Set(upstream
    .filter((connection) => connection.neighborDefinitionId === inputSplitterId)
    .map((connection) => `${connection.portGroupId}:${connection.portId}`));

  if (inputSplitterId !== null && splitterKeys.size > 0) {
    // 同一设备连接多个端口时次序相同；只比较实际连接的上游，不比较接收设备自身。
    const last = upstream.reduce((latest, connection) =>
      connection.neighborPlacementOrder > latest.neighborPlacementOrder ? connection : latest);
    const splitterPriority = last.neighborDefinitionId === inputSplitterId ? 9 : 1;
    for (const port of inputPorts) {
      result.push({
        ...port,
        priorityGroup: splitterKeys.has(`${port.portGroupId}:${port.portId}`)
          ? splitterPriority
          : 10 - splitterPriority,
      });
    }
  }

  if (outputConvergerId !== null) {
    const convergerKeys = new Set(context.connections
      .filter((connection) => connection.neighborDefinitionId === outputConvergerId)
      .map((connection) => `${connection.portGroupId}:${connection.portId}`));
    for (const group of definition.portGroups) {
      if (group.direction !== "output") continue;
      for (const port of group.ports) {
        if (convergerKeys.has(`${group.id}:${port.id}`)) {
          result.push({ portGroupId: group.id, portId: port.id, priorityGroup: 9 });
        }
      }
    }
  }
  return result.length === 0 ? null : result;
}
