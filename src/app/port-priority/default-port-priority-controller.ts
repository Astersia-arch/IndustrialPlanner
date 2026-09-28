import { observable, runInAction } from "mobx";
import type { WorldDocument, WorldEntity } from "@/domain/document/world-document";
import type { EditorContract } from "@/domain/editor/editor-contract";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { DefaultPortPriority } from "@/domain/registry/types/default-port-priority";
import { resolveRotatedPortGeometry } from "@/shared/geometry/port";
import { findDirectPortConnections, type DirectPort } from "@/shared/port-connections";
import { collectDefaultPortPriorityGroups } from "@/shared/port-priority-groups";

/** 文档消费侧的派生缓存；Registry 保持无状态，Inspector 读取时不查询邻接。 */
export class DefaultPortPriorityController {
  private readonly results = observable.box<ReadonlyMap<string, readonly DefaultPortPriority[]>>(new Map(), { deep: false });
  private layout: readonly WorldEntity[] = [];
  private documentKey: string | null = null;
  private entities: WorldDocument["entities"] | null = null;
  private entityOrder: WorldDocument["entityOrder"] | null = null;
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly registry: RegistryContract) {}

  public get(entityId: string): readonly DefaultPortPriority[] | null {
    return this.results.get().get(entityId) ?? null;
  }

  public getAll(): ReadonlyMap<string, readonly DefaultPortPriority[]> {
    return this.results.get();
  }

  public bind(editor: EditorContract): () => void {
    this.dispose();
    this.update(editor.document.getSnapshot());
    const unsubscribe = editor.document.subscribe((document) => this.update(document));
    this.unsubscribe = unsubscribe;
    return () => {
      if (this.unsubscribe === unsubscribe) this.dispose();
    };
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.layout = [];
    this.documentKey = null;
    this.entities = null;
    this.entityOrder = null;
    runInAction(() => this.results.set(new Map()));
  }

  public update(document: WorldDocument): void {
    if (this.documentKey === document.documentKey && this.entities === document.entities
      && this.entityOrder === document.entityOrder) return;
    this.entities = document.entities;
    this.entityOrder = document.entityOrder;
    const ordered = new Set(document.entityOrder);
    for (const id of Object.keys(document.entities).filter((id) => !ordered.has(id)).sort()) ordered.add(id);
    const entities = [...ordered].flatMap((id) => document.entities[id] === undefined ? [] : [document.entities[id]!]);
    // 配方、用户优先级等配置变化不改变连接；保留已经计算的邻接和默认值。
    if (this.documentKey === document.documentKey && entities.length === this.layout.length
      && entities.every((entity, index) => samePlacement(entity, this.layout[index]!))) return;
    this.documentKey = document.documentKey;
    this.layout = entities;

    const ports: DirectPort[] = [];
    const logisticsIds = new Set<string>();
    for (const entity of entities) {
      const definition = this.registry.queries.findEntityDefinition(entity.definitionId);
      if (definition === null) continue;
      if (this.registry.queries.isGeneralLogisticsDevice(entity.definitionId)) logisticsIds.add(entity.id);
      for (const group of definition.portGroups) {
        const directions: readonly ("input" | "output")[] = group.direction === "bidirectional"
          ? ["input", "output"] : [group.direction];
        for (const port of group.ports) {
          const geometry = resolveRotatedPortGeometry({ footprint: definition.footprint, port, rotation: entity.rotation });
          const insideGridPoint = { x: entity.position.x + geometry.cell.x, y: entity.position.y + geometry.cell.y };
          for (const direction of directions) {
            ports.push({
              deviceId: entity.id,
              portGroupId: group.id,
              portDefinitionId: port.id,
              direction,
              isPipe: group.isPipe,
              insideGridPoint,
              outsideGridPoint: { x: insideGridPoint.x + geometry.delta.x, y: insideGridPoint.y + geometry.delta.y },
            });
          }
        }
      }
    }
    const connections = findDirectPortConnections(ports, (id) => logisticsIds.has(id));
    const results = collectDefaultPortPriorityGroups(
      entities.map((entity, placementOrder) => ({ id: entity.id, definitionId: entity.definitionId, placementOrder })),
      connections,
      this.registry.queries,
    );
    runInAction(() => this.results.set(results));
  }
}

function samePlacement(left: WorldEntity, right: WorldEntity): boolean {
  return left.id === right.id && left.definitionId === right.definitionId
    && left.rotation === right.rotation && left.position.x === right.position.x && left.position.y === right.position.y;
}
