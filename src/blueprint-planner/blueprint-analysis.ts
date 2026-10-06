import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type { BlueprintPlannerBlueprintBoundary, BlueprintPlannerBlueprintInput } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { SimulationBlueprintAnalysis, SimulationBlueprintAnalysisPort, SimulationBlueprintRunReport } from "@/domain/simulation";
import { CONSUMPTION_RECIPE_TAG } from "@/shared/consumption-channel";
import { isRecipeAvailableByActivity } from "@/shared/registry/activity-availability";

export const blueprintBoundaryKey = (boundary: BlueprintPlannerBlueprintBoundary) =>
  `${boundary.entityId}/${boundary.portGroupId}/${boundary.portId}/${boundary.direction}`;

/** 同一实体的库存通道分别追踪，桥接器的独立通道不能按实体合并。 */
export function blueprintMaterialGraph(registry: RegistryContract, blueprint: BlueprintDocument,
  analysis: SimulationBlueprintAnalysis, boundaries: readonly BlueprintPlannerBlueprintBoundary[], activeActivityIds: readonly string[] = []) {
  const ports = new Map(analysis.ports.map(port => [port.id, port]));
  const items = new Map(analysis.ports.map(port => [port.id, new Set<string>()]));
  const edges = analysis.connections.map(edge => ({ from: edge.sourcePortId, to: edge.targetPortId }));
  const possibleRecipes = new Map<string, Set<string>>();
  const add = (id: string, itemId: string) => {
    const port = ports.get(id);
    if (port?.acceptedItemIds.includes(itemId)) items.get(id)!.add(itemId);
  };
  for (const port of analysis.ports) {
    const entity = blueprint.entities[port.entityId];
    if (!entity) continue;
    const channels = analysis.channels.filter(channel => channel.entityId === entity.id);
    if (registry.queries.isGeneralLogisticsDevice(entity.definitionId) || channels.length === 0 || entity.definitionId === "storager_1") {
      if (port.direction === "input") for (const output of analysis.ports.filter(candidate => candidate.entityId === entity.id
        && candidate.direction === "output" && candidate.nodeIds.some(id => port.nodeIds.includes(id)))) {
        edges.push({ from: port.id, to: output.id });
      }
    }
    for (const slot of analysis.slots) if (slot.entityId === entity.id && slot.itemId && (slot.infinite || slot.count > 0)
      && port.nodeIds.includes(slot.nodeId)) add(port.id, slot.itemId);
    for (const boundary of boundaries) if (boundary.entityId === entity.id && boundary.direction === "input" && boundary.itemId
      && (boundary.kind === "facility" || boundary.portGroupId === port.groupId && boundary.portId === port.portId)) add(port.id, boundary.itemId);
    for (const channel of channels) {
      const recipeIds = channel.manual && channel.configuredRecipeId ? [channel.configuredRecipeId] : channel.observedRecipeIds;
      for (const recipeId of recipeIds) {
        const recipe = registry.queries.findRecipeDefinition(recipeId);
        if (recipe && port.direction === "output" && port.nodeIds.some(id => channel.outputNodeIds.includes(id))) {
          for (const output of recipe.outputs) add(port.id, output.itemId);
        }
      }
    }
  }
  // 实际转移能补充自动配方和启动路径；预热中的第二种物品不能被最终稳态覆盖。
  for (const transfer of analysis.transfers) {
    add(transfer.sourcePortId, transfer.itemId); add(transfer.targetPortId, transfer.itemId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) for (const item of items.get(edge.from) ?? []) {
      const before = items.get(edge.to)?.size ?? 0;
      add(edge.to, item);
      if ((items.get(edge.to)?.size ?? 0) !== before) changed = true;
    }
    for (const channel of analysis.channels) {
      const entity = blueprint.entities[channel.entityId];
      if (!entity || channel.manual || registry.queries.isGeneralLogisticsDevice(entity.definitionId)) continue;
      const incoming = new Set(analysis.ports.filter(port => port.direction === "input"
        && port.nodeIds.some(id => channel.inputNodeIds.includes(id))).flatMap(port => [...items.get(port.id)!]));
      for (const slot of analysis.slots) if (channel.inputNodeIds.includes(slot.nodeId) && slot.itemId && (slot.count > 0 || slot.infinite)) incoming.add(slot.itemId);
      const possible = possibleRecipes.get(`${entity.id}/${channel.channelId}`) ?? new Set<string>();
      for (const recipe of registry.recipeDefinitions.filter(recipe => recipe.machineId === entity.definitionId
        && recipe.tags.includes(CONSUMPTION_RECIPE_TAG) === channel.consumption && isRecipeAvailableByActivity(recipe, activeActivityIds)
        && recipe.inputs.every(input => incoming.has(input.itemId)))) {
        possible.add(recipe.id);
        for (const port of analysis.ports.filter(port => port.direction === "output" && port.nodeIds.some(id => channel.outputNodeIds.includes(id)))) {
          const before = items.get(port.id)!.size;
          for (const output of recipe.outputs) add(port.id, output.itemId);
          if (items.get(port.id)!.size !== before) changed = true;
        }
      }
      possibleRecipes.set(`${entity.id}/${channel.channelId}`, possible);
    }
  }
  return { ports, items, edges, possibleRecipes };
}

export function inspectBlueprintBoundaries(registry: RegistryContract, blueprint: BlueprintDocument,
  analysis: SimulationBlueprintAnalysis, activeActivityIds: readonly string[] = []): BlueprintPlannerBlueprintBoundary[] {
  const result: BlueprintPlannerBlueprintBoundary[] = [];
  const connected = new Set(analysis.connections.flatMap(edge => [edge.sourcePortId, edge.targetPortId]));
  const graph = blueprintMaterialGraph(registry, blueprint, analysis, [], activeActivityIds);
  const infer = (ports: readonly SimulationBlueprintAnalysisPort[]) => {
    const ids = new Set(ports.flatMap(port => [...graph.items.get(port.id) ?? []]));
    if (ids.size === 1) return [...ids][0]!;
    const explicit = new Set(ports.flatMap(port => port.admissionItemId ? [port.admissionItemId]
      : port.acceptedItemIds.length === 1 ? port.acceptedItemIds : []));
    return explicit.size === 1 ? [...explicit][0]! : null;
  };
  for (const entityId of blueprint.entityOrder) {
    const entity = blueprint.entities[entityId]!;
    const ports = analysis.ports.filter(port => port.entityId === entityId);
    const definition = registry.queries.findEntityDefinition(entity.definitionId)!;
    const inputs = ports.filter(port => port.direction === "input"), outputs = ports.filter(port => port.direction === "output");
    const inUse = inputs.some(port => connected.has(port.id)), outUse = outputs.some(port => connected.has(port.id));
    const source = ["unloader_1", "udpipe_unloader_1", "udpipe_unloader_2"].includes(entity.definitionId)
      || entity.definitionId === "storager_1" && outUse && !inUse
      || definition.uiGroup === "cheat" && outUse && !inUse;
    const sink = ["loader_1", "udpipe_loader_1", "udpipe_loader_2"].includes(entity.definitionId)
      || entity.definitionId === "storager_1" && inUse && !outUse
      || definition.uiGroup === "cheat" && inUse && !outUse;
    if (source || sink) {
      const direction = source ? "input" : "output";
      result.push({ entityId, portGroupId: "", portId: "", direction, kind: "facility", itemId: infer(source ? outputs : inputs) });
    } else if (registry.queries.isBelt(entity.definitionId) || registry.queries.isPipe(entity.definitionId)) {
      for (const port of ports.filter(port => !connected.has(port.id))) result.push({ entityId, portGroupId: port.groupId,
        portId: port.portId, direction: port.direction, kind: "port", itemId: infer([port]) });
    }
  }
  return result;
}

export function assertBlueprintRecognition(registry: RegistryContract, input: BlueprintPlannerBlueprintInput,
  report: SimulationBlueprintRunReport): ReturnType<typeof blueprintMaterialGraph> {
  if (report.status !== "completed" || !report.analysis || report.diagnostics.some(entry => entry.severity === "error")) {
    throw new Error(report.diagnostics.find(entry => entry.severity === "error")?.message ?? "蓝图识别未完成，禁止优化。");
  }
  if (report.deviceStatuses.some(entry => ["not-in-power-net", "no-power"].includes(entry.status))) throw new Error("蓝图存在未供电设备，无法建立产率基线。");
  const graph = blueprintMaterialGraph(registry, input.blueprint, report.analysis, input.boundaries, input.activeActivityIds);
  for (const [id, items] of graph.items) if (items.size > 1) {
    const port = graph.ports.get(id)!;
    throw new Error(`疑似混带：${port.entityId} / ${port.groupId} / ${port.portId}，物品：${[...items].join("、")}。`);
  }
  for (const channel of report.analysis.channels.filter(channel => input.blueprint.entities[channel.entityId])) {
    const definition = registry.queries.findEntityDefinition(input.blueprint.entities[channel.entityId]!.definitionId)!;
    if (registry.queries.isGeneralLogisticsDevice(definition.id) || definition.uiGroup === "cheat" || definition.id === "storager_1"
      || input.boundaries.some(boundary => boundary.kind === "facility" && boundary.entityId === channel.entityId)) continue;
    if (!channel.inputNodeIds.length && !channel.outputNodeIds.length && !channel.configuredRecipeId) continue;
    const recipes = new Set(channel.observedRecipeIds);
    const possible = graph.possibleRecipes.get(`${channel.entityId}/${channel.channelId}`);
    if (possible && possible.size > 1) throw new Error(`设备 ${channel.entityId} 的通道 ${channel.channelId} 存在多种可运行配方，禁止优化。`);
    if (channel.consumption && recipes.size === 0 && !channel.configuredRecipeId && (possible?.size ?? 0) <= 1) continue;
    if (recipes.size === 0 && channel.manual && channel.configuredRecipeId) recipes.add(channel.configuredRecipeId);
    if (recipes.size !== 1 || channel.manual && channel.configuredRecipeId && !recipes.has(channel.configuredRecipeId)) {
      throw new Error(`无法确定设备 ${channel.entityId} 的配方通道 ${channel.channelId}，禁止优化。`);
    }
  }
  const allowedSources = new Set(input.boundaries.filter(boundary => boundary.direction === "input").map(boundary => boundary.entityId));
  if (report.analysis.slots.some(slot => slot.infinite && input.blueprint.entities[slot.entityId] && !allowedSources.has(slot.entityId))) {
    throw new Error("内部设备使用了未声明的无限库存，无法建立真实产率基线。");
  }
  return graph;
}

/** 只容许配方批次和输送相位的波动，不把持续增减库存或末段停产当作稳态。 */
export function assertBlueprintSteadyState(registry: RegistryContract, report: SimulationBlueprintRunReport,
  probes: readonly { id: string; itemId: string; entityIds: readonly string[]; direction: "input" | "output" }[]): void {
  if (!report.analysis || report.inventorySamples.length < 5) throw new Error("缺少稳态识别数据。");
  const batches = new Map<string, number>();
  for (const channel of report.analysis.channels) for (const id of channel.observedRecipeIds) {
    const recipe = registry.queries.findRecipeDefinition(id);
    if (!recipe) continue;
    if (recipe.durationSeconds * 4 > report.observationSeconds) throw new Error("观察窗口不足以覆盖配方周期，禁止优化。");
    for (const flow of [...recipe.inputs, ...recipe.outputs]) batches.set(flow.itemId, Math.max(batches.get(flow.itemId) ?? 1, flow.amount));
  }
  const entityByPort = new Map(report.analysis.ports.map(port => [port.id, port.entityId]));
  for (const probe of probes.filter(probe => probe.direction === "input")) {
    const inside = new Set(probe.entityIds), windows = [0, 0, 0, 0];
    for (const transfer of report.analysis.transfers) if (transfer.itemId === probe.itemId
      && inside.has(entityByPort.get(transfer.targetPortId) ?? "") && !inside.has(entityByPort.get(transfer.sourcePortId) ?? "")) {
      transfer.windowAmounts.forEach((amount, index) => { windows[index]! += amount; });
    }
    if (Math.min(...windows) <= 0 || Math.max(...windows) - Math.min(...windows) > 2 * (batches.get(probe.itemId) ?? 1)) {
      throw new Error(`出口 ${probe.itemId} 尚未达到持续稳定产出，禁止优化。`);
    }
  }
  const samples = report.inventorySamples.slice(-5);
  const items = new Set(samples.flatMap(sample => Object.keys(sample.itemAmounts)));
  for (const item of items) {
    const counts = samples.map(sample => sample.itemAmounts[item] ?? 0);
    const delta = counts.at(-1)! - counts[0]!;
    if (Math.abs(delta) > 2 * (batches.get(item) ?? 1) && counts.slice(1).every((count, index) =>
      delta > 0 ? count >= counts[index]! : count <= counts[index]!)) {
      throw new Error(`库存 ${item} 持续${delta > 0 ? "积压" : "消耗"}，无法确认持续产率。`);
    }
  }
}
