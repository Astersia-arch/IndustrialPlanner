import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import { resolveEntityGridRect } from "@/shared/geometry/power-range";
import { findDirectPortConnections } from "@/shared/port-connections";
import { getPlannerPorts, type PlannerPort } from "@/blueprint-planner/geometry";
import { PlannerRouter } from "@/blueprint-planner/router";
import { PlannerCandidateError } from "@/blueprint-planner/model";

/** 提取人工蓝图的几何网表。保留分汇流、准入口和桥接器，避免把桥接的独立通道合并。 */
export function extractReferenceLayout(registry: RegistryContract, original: BlueprintDocument) {
  const blueprint = structuredClone(original);
  const rects = blueprint.entityOrder.map(id => resolveEntityGridRect({ entity: blueprint.entities[id]!,
    definition: registry.queries.findEntityDefinition(blueprint.entities[id]!.definitionId)! }));
  const left = Math.min(...rects.map(rect => rect.x)), top = Math.min(...rects.map(rect => rect.y));
  const width = Math.max(...rects.map(rect => rect.x + rect.width)) - left;
  const height = Math.max(...rects.map(rect => rect.y + rect.height)) - top;
  for (const entity of Object.values(blueprint.entities)) {
    entity.position = { x: entity.position.x - left, y: entity.position.y - top };
  }
  const isTrack = (id: string) => {
    const definitionId = blueprint.entities[id]!.definitionId;
    return registry.queries.isBelt(definitionId) || registry.queries.isPipe(definitionId);
  };
  const ports = blueprint.entityOrder.flatMap(id => {
    const entity = blueprint.entities[id]!, definition = registry.queries.findEntityDefinition(entity.definitionId)!;
    return (["input", "output"] as const).flatMap(direction => getPlannerPorts(registry, entity, definition, direction)
      .map(port => ({ ...port, deviceId: id, portGroupId: String(port.groupIndex), portDefinitionId: String(port.portIndex),
        isPipe: port.kind === "pipe", insideGridPoint: port.cell, outsideGridPoint: port.outside })));
  });
  const connections = findDirectPortConnections(ports, id => registry.queries.isGeneralLogisticsDevice(blueprint.entities[id]!.definitionId));
  const wires: Array<{ source: PlannerPort; target: PlannerPort; originalCells: number }> = [];
  for (const connection of connections.filter(entry => !isTrack(entry.sourcePort.entityId))) {
    let target = connection.targetPort, count = 0;
    const seen = new Set<string>();
    while (isTrack(target.entityId)) {
      if (seen.has(target.entityId)) throw new Error(`无终点物流回路：${target.entityId}`);
      seen.add(target.entityId); count++;
      const next = connections.filter(entry => entry.sourcePort.entityId === target.entityId);
      if (next.length !== 1) break;
      target = next[0]!.targetPort;
    }
    if (!isTrack(target.entityId)) wires.push({ source: connection.sourcePort, target, originalCells: count });
  }
  return { blueprint, width, height, wires, anchors: blueprint.entityOrder.filter(id => !isTrack(id)).map(id => blueprint.entities[id]!) };
}

/** 固定人工设备及端口，只重建路径；这是几何诊断，不冒充产量、限速或自启动验收。 */
export async function rerouteReferenceLayout(registry: RegistryContract, blueprint: BlueprintDocument, checkBudget: () => void) {
  const reference = extractReferenceLayout(registry, blueprint);
  const history = new Map<string, number>();
  const order = reference.wires.map((_, index) => index).sort((a, b) => reference.wires[a]!.originalCells - reference.wires[b]!.originalCells);
  const started = performance.now();
  let bestConnected = 0, failure = "", attempts = 0;
  let blockedWire: (typeof reference.wires)[number] | undefined;
  for (; attempts < 24; attempts++) {
    const router = new PlannerRouter(registry, reference.anchors, reference.wires.flatMap(wire => [wire.source, wire.target]),
      { minimumX: 0, minimumY: 0, maximumX: reference.width - 1, maximumY: reference.height - 1, escapeLength: 0, history });
    let connected = 0;
    try {
      for (const index of order) {
        checkBudget();
        const wire = reference.wires[index]!;
        await router.connect(wire.source, wire.target, checkBudget);
        connected++;
      }
      const entities = [...reference.anchors, ...router.entities];
      return { status: "routed" as const, width: reference.width, height: reference.height, wireCount: order.length,
        connected, attempts: attempts + 1, elapsedMs: performance.now() - started,
        blueprint: { ...reference.blueprint, entities: Object.fromEntries(entities.map(entity => [entity.id, entity])), entityOrder: entities.map(entity => entity.id) } };
    } catch (error) {
      if (!(error instanceof PlannerCandidateError)) throw error;
      bestConnected = Math.max(bestConnected, connected); failure = error.message;
      blockedWire = reference.wires[order[connected]!];
      for (const [route, cells] of router.conflicts) for (const cell of cells) {
        const key = `${route}|${cell}`; history.set(key, (history.get(key) ?? 0) + 3);
      }
      if (!router.conflicts.size) break;
      const blocked = order.splice(connected, 1)[0]!; order.unshift(blocked);
    }
  }
  return { status: "blocked" as const, width: reference.width, height: reference.height, wireCount: order.length,
    connected: bestConnected, attempts: Math.min(24, attempts + 1), elapsedMs: performance.now() - started, failure, blockedWire };
}
