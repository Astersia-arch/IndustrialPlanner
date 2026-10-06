import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { SimulationBlueprintRunRequest } from "@/domain/simulation";
import { createWorldDocument } from "@/domain/document/world-document";
import { resolveEntityGridRect } from "@/shared/geometry/power-range";

/** 施工验收包含用户需补齐的外部存取线；整体平移只适配验证地图，不修改交付或搜索坐标。 */
export function createPlannerPlacementScene(registry: RegistryContract, execution: SimulationBlueprintRunRequest, baseId: string) {
  const blueprint = execution.blueprint;
  const entries = [...blueprint.entityOrder.map(id => blueprint.entities[id]!), ...execution.scene.externalEntities
    .filter(entity => entity.definitionId === "log_hongs_bus" || entity.definitionId === "log_hongs_bus_source")];
  const rects = entries.map(entity => resolveEntityGridRect({ entity, definition: registry.queries.findEntityDefinition(entity.definitionId)! }));
  const x = Math.min(0, ...rects.map(rect => rect.x)), y = Math.min(0, ...rects.map(rect => rect.y));
  const entities = entries.map(entity => ({ ...entity, position: { x: entity.position.x - x, y: entity.position.y - y } }));
  const document = createWorldDocument({ baseId });
  document.entities = Object.fromEntries(entities.map(entity => [entity.id, entity]));
  document.entityOrder = entities.map(entity => entity.id);
  document.slotLinks = blueprint.slotLinks;
  return document;
}
