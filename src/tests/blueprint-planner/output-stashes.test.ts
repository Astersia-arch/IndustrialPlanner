// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createProductionNetwork } from "@/blueprint-planner/production-network";
import { PlannerPlacement, placeProduction } from "@/blueprint-planner/placement";
import { addTerminals, getPlannerStashDrainPorts } from "@/blueprint-planner/terminals";
import { wireProductionNetwork } from "@/blueprint-planner/wiring";
import { comparePlannerRanks, countPlannerOutputStashes } from "@/blueprint-planner/quality";
import { capturePlannerSeed } from "@/blueprint-planner/search-seed";
import { PlannerSearchPortfolio } from "@/blueprint-planner/search-portfolio";
import { PlannerBatchSession } from "@/scripts/eda/planner-runner";
import { saveSuccessfulPlanning } from "@/scripts/eda/artifacts";
import { meetsOperatingLimits, meetsProductionTargets } from "@/blueprint-planner/verification";
import input from "./fixtures/separator-core.json";

async function networkFor(request: BlueprintPlannerRequest, variant = 0) {
  const registry = createRegistryContract();
  const network = createProductionNetwork(registry, request);
  const placement = new PlannerPlacement(registry, 32, 7, 2, 1, 1);
  await placeProduction(registry, network, placement, 0);
  addTerminals(registry, network, placement, false, 2, true, variant);
  const wires = await wireProductionNetwork(registry, network, placement, () => {}, true);
  return { registry, network, wires };
}

it.each([0, 1])("60/min 由两条独立线路入箱，箱数方案 %i 保持同物品及足量排空", async variant => {
  const request = structuredClone(input.request) as BlueprintPlannerRequest;
  const before = JSON.stringify(request);
  const { registry, network, wires } = await networkFor(request, variant);
  const stashes = network.nodes.filter(node => node.definition.id === "storager_1");
  expect(stashes).toHaveLength(variant + 1);
  const incoming = wires.filter(wire => stashes.some(node => node.entity.id === wire.target.entityId));
  expect(incoming.map(wire => wire.perMinute)).toEqual([30, 30]);
  expect(new Set(incoming.map(wire => `${wire.target.entityId}/${wire.target.groupIndex}/${wire.target.portIndex}`)).size).toBe(2);
  expect(stashes.flatMap(node => getPlannerStashDrainPorts(registry, node))).toHaveLength(2);
  for (const node of stashes) {
    expect(new Set(node.inputs.map(flow => flow.itemId))).toEqual(new Set(["item_filter_core"]));
    expect(Object.entries(node.entity.config).filter(([key]) => key.endsWith(".lock")).map(([, value]) => value)).toEqual(Array(6).fill("item_filter_core"));
  }
  expect(JSON.stringify(request)).toBe(before);
});

it("超过一箱三口容量时增加箱数，有限方案包含中间箱数，异物分箱", async () => {
  const base = structuredClone(input.request) as BlueprintPlannerRequest;
  const request: BlueprintPlannerRequest = { ...base, plan: { ...base.plan,
    targets: [{ itemId: "item_filter_core", perMinute: 120 }, { itemId: "item_copper_jar", perMinute: 30 }],
    externalSupplies: [{ itemId: "item_copper_jar", perMinute: 90 }, { itemId: "item_xiranite_powder", perMinute: 60 }],
    recipes: base.plan.recipes.map(recipe => ({ ...recipe, deviceCount: 2, cyclesPerMinute: 60,
      inputs: recipe.inputs.map(flow => ({ ...flow, perMinute: flow.perMinute * 2 })), outputs: recipe.outputs.map(flow => ({ ...flow, perMinute: flow.perMinute * 2 })) })) } };
  for (let variant = 0; variant < 3; variant++) {
    const { registry, network } = await networkFor(request, variant);
    const stashes = network.nodes.filter(node => node.definition.id === "storager_1");
    expect(stashes.filter(node => node.inputs[0]!.itemId === "item_filter_core")).toHaveLength(2 + variant);
    expect(stashes.filter(node => node.inputs[0]!.itemId === "item_copper_jar")).toHaveLength(1);
    for (const node of stashes) {
      expect(new Set(node.inputs.map(flow => flow.itemId)).size).toBe(1);
      expect(getPlannerStashDrainPorts(registry, node).length).toBeLessThanOrEqual(3);
    }
  }
});

it("面积优先于箱数，同面积少箱优先；续搜和检查点不会屏蔽少箱平局", async () => {
  expect(comparePlannerRanks({ area: 99, outputStashCount: 2 }, { area: 100, outputStashCount: 1 })).toBeLessThan(0);
  expect(comparePlannerRanks({ area: 100, outputStashCount: 1, secondary: 1000 }, { area: 100, outputStashCount: 2, secondary: 0 })).toBeLessThan(0);
  const request = structuredClone(input.request) as BlueprintPlannerRequest;
  const split = await networkFor(request, 1), packed = await networkFor(request);
  const seed = capturePlannerSeed(request, split.network, split.wires, [], 20, 20);
  const smallerCount = capturePlannerSeed(request, packed.network, packed.wires, [], 20, 20);
  const pool = new PlannerSearchPortfolio(request, seed);
  expect(pool.next(0).maximumArea).toBe(399);
  expect(pool.next(3)).toMatchObject({ maximumArea: 400, seed: undefined });
  pool.remember(smallerCount);
  expect(countPlannerOutputStashes(pool.next(4).seed!.network.nodes)).toBe(1);
  expect(pool.next(7).maximumArea).toBe(399);
  const restored = new PlannerSearchPortfolio(request);
  restored.restore(pool.snapshot());
  expect(restored.next(8)).toEqual(pool.next(8));
});

it("真实 Worker 的合箱与分箱都持续输出 60/min，长窗口不依赖箱内缓冲", async () => {
  const request = structuredClone(input.request) as BlueprintPlannerRequest;
  const session = new PlannerBatchSession();
  try {
    for (const variant of [0, 3]) {
      const candidate = await session.planner.build(request, variant, 60_000, { maxEvaluations: 50_000 });
      const boxes = candidate.execution.blueprint.entityOrder.filter(id => candidate.execution.blueprint.entities[id]!.definitionId === "storager_1");
      expect(boxes).toHaveLength(variant === 0 ? 1 : 2);
      const execution = { ...candidate.execution, warmupSeconds: 600, observationSeconds: 600, maxWallTimeMs: 60_000 };
      const report = await session.simulation.actions.runBlueprint(execution);
      expect(meetsProductionTargets(request, report)).toBe(true);
      expect(meetsOperatingLimits(candidate.supplyAudit, report)).toBe(true);
      expect(report.probes.find(probe => probe.id === "item_filter_core")?.perMinute).toBe(60);
      await saveSuccessfulPlanning(session.workspace.registry, `${request.plan.name}-${boxes.length}箱`, candidate.execution.blueprint,
        request, { candidate, execution, report });
    }
  } finally { await session.dispose(); }
}, 150_000);
