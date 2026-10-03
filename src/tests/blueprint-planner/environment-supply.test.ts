// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BlueprintPlannerRequest, BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createProductionNetwork, createRecipeNode, supplyAuxiliaryDemand } from "@/blueprint-planner/production-network";
import { PlannerPlacement, placeProduction, redundantEnvironmentStations } from "@/blueprint-planner/placement";
import { emptyPlannerCheckpoint, parsePlannerTaskFile, PLANNER_ALGORITHM_VERSION } from "@/blueprint-planner/task-checkpoint";
import { plannerRequestKey } from "@/blueprint-planner/search-seed";
import input from "./fixtures/environment-supply.json";

const request = () => structuredClone(input) as BlueprintPlannerRequest;

describe("EDA 环境设施与真实补料", () => {
  it("19 格窄初排能自动补上散布机，不要求用户提供台数", async () => {
    const registry = createRegistryContract(), network = createProductionNetwork(registry, request());
    const placement = new PlannerPlacement(registry, 16, 7, 2);
    placement.maximumX = 19;
    await placeProduction(registry, network, placement, 0);
    const environments = network.nodes.filter(node => node.purpose === "environment");
    expect(environments).toHaveLength(1);
    expect(environments[0]!.entity.position.x + environments[0]!.definition.footprint.width).toBeLessThanOrEqual(19);
    expect(placement.placed).toHaveLength(2);
    expect(redundantEnvironmentStations(network)).toEqual([]);
  });

  it("增量需求优先复用自产设备余量，运行供料只按实际台数增加", () => {
    const registry = createRegistryContract(), network = createProductionNetwork(registry, request());
    supplyAuxiliaryDemand(registry, network, "item_gas_acid", 6);
    supplyAuxiliaryDemand(registry, network, "item_gas_acid", 12);
    const producers = network.nodes.filter(node => node.recipe?.id === "liquid_transmuter_1_gas_gas_acid_1");
    expect(producers).toHaveLength(1);
    expect(producers[0]!.outputs[0]!.perMinute).toBe(18);
    expect(producers[0]!.inputs.find(flow => flow.itemId === "item_liquid_xiranite")?.perMinute).toBe(6);
    supplyAuxiliaryDemand(registry, network, "item_gas_acid", 18);
    expect(network.nodes.filter(node => node.recipe?.id === producers[0]!.recipe!.id)).toHaveLength(2);
    expect(network.nodes.flatMap(node => node.outputs).filter(flow => flow.itemId === "item_gas_acid").reduce((sum, flow) => sum + flow.perMinute, 0)).toBe(36);
  });

  it("外供规则进入实际可用来源，不生成被切走的自产设施", () => {
    const registry = createRegistryContract(), original = request();
    const network = createProductionNetwork(registry, { ...original,
      plan: { ...original.plan, supplyPolicies: [{ itemId: "item_gas_acid", source: "external" }] } });
    expect(network.request.plan.infiniteItemIds).toContain("item_gas_acid");
    expect(supplyAuxiliaryDemand(registry, network, "item_gas_acid", 6)).toEqual([]);
    expect(network.nodes).toHaveLength(1);
  });

  it("裁撤未使用设施仍保留必需覆盖，移除后释放初排占地", async () => {
    const registry = createRegistryContract(), network = createProductionNetwork(registry, request());
    const recipe = registry.queries.findRecipeDefinition("r_gas_diffuser_acid_gas_environment_basic")!;
    for (let index = 0; index < 3; index++) network.nodes.push(createRecipeNode(registry, recipe, `manual-environment-${index}`, 6, "environment"));
    const placement = new PlannerPlacement(registry, 40, 7, 2);
    placement.maximumX = 47;
    await placeProduction(registry, network, placement, 0);
    const redundant = redundantEnvironmentStations(network);
    expect(redundant).toHaveLength(2);
    placement.remove(redundant);
    for (const node of redundant) expect(placement.canPlace(node, node.entity.position, node.entity.rotation)).toBe(true);
    expect(placement.placed.filter(node => node.purpose === "environment")).toHaveLength(1);
  });

  it("任务 JSON 往返保留规则，规则改变不能复用另一供料方案的检查点键", () => {
    const registry = createRegistryContract(), original = request();
    const file: BlueprintPlannerTaskFile = { formatVersion: 1, algorithmVersion: PLANNER_ALGORITHM_VERSION,
      taskId: "environment-test", request: original, checkpoint: emptyPlannerCheckpoint(),
      progress: { taskId: "environment-test", status: "waiting", phase: "preparing", startedAt: 1,
        elapsedMs: 0, estimatedProgress: null, candidateCount: 0, evaluatedProposals: 0, roundEvaluatedProposals: 0,
        validatedCandidateCount: 0, bestArea: null, message: null } };
    expect(parsePlannerTaskFile(JSON.parse(JSON.stringify(file)), registry).request.plan.supplyPolicies).toEqual(original.plan.supplyPolicies);
    expect(plannerRequestKey(original)).not.toBe(plannerRequestKey({ ...original,
      plan: { ...original.plan, supplyPolicies: [{ itemId: "item_gas_acid", source: "external" }] } }));
  });
});

describe("环境供料交付验证", () => {
  it.each(["production", "external"] as const)("%s：真实管线和 Dense 2 tick/s 达到目标", async mode => {
    const [{ createWorkspaceState }, { createSimulationHost }, { createPlannerCandidate }, { saveSuccessfulPlanning }] = await Promise.all([
      import("@/domain/document/workspace-state"), import("@/simulation/simulation-host"),
      import("@/blueprint-planner/candidate"), import("@/scripts/eda/artifacts"),
    ]);
    const original = request();
    const current: BlueprintPlannerRequest = mode === "production" ? original : { ...original,
      plan: { ...original.plan, supplyPolicies: [{ itemId: "item_gas_acid", source: "external" }] } };
    const workspace: import("@/domain/document/workspace-contract").WorkspaceContract = {
      state: createWorkspaceState(), registry: createRegistryContract(), app: null, editor: null, render: null,
      simulation: null, sync: null, audio: null, blueprintPlanner: null,
    };
    const host = createSimulationHost(workspace, { engineKind: "dense-v2", workerMode: "runtime", blueprintDenseTickRate: 2 });
    const started = performance.now();
    try {
      const candidate = await createPlannerCandidate(workspace.registry, current, 0,
        () => { if (performance.now() - started > 90_000) throw new Error("环境布局验证超时"); }, () => {});
      expect(candidate.metrics.gasDiffuserCount).toBe(1);
      expect(candidate.metrics.productionDeviceCount).toBe(mode === "production" ? 2 : 1);
      const report = await host.actions.runBlueprint({ ...candidate.execution, maxWallTimeMs: 240_000 });
      expect(report.status).toBe("completed");
      expect(report.diagnostics.filter(entry => entry.severity === "error")).toEqual([]);
      expect(report.probes.find(probe => probe.id === "item_gas_copper_enr2")?.perMinute).toBeGreaterThanOrEqual(30);
      const running = report.probes.filter(probe => probe.id.startsWith("operating:"));
      expect(running).toHaveLength(mode === "production" ? 2 : 1);
      expect(running.every(probe => probe.perMinute === 6)).toBe(true);
      await saveSuccessfulPlanning(workspace.registry, `environment-${mode}`, candidate.execution.blueprint, current,
        { elapsedMs: performance.now() - started, engineKind: "dense-v2", ticksPerSecond: 2, report, metrics: candidate.metrics });
    } finally { host.dispose(); }
  }, 360_000);
});

it("环境评估保留暂未覆盖的设备约束，并从所有同类设施选择覆盖", async () => {
  const { CompactLayoutSearch } = await import("@/blueprint-planner/compact-layout");
  const registry = createRegistryContract(), network = createProductionNetwork(registry, request());
  network.nodes[0]!.entity.position = { x: 7, y: 2 };
  const recipe = registry.queries.findRecipeDefinition("r_gas_diffuser_acid_gas_environment_basic")!;
  const distant = createRecipeNode(registry, recipe, "distant", 6, "environment");
  distant.entity.position = { x: 30, y: 30 }; network.nodes.push(distant);
  const evaluate = () => {
    const statistics: import("@/blueprint-planner/search-types").PlannerSearchStatistics = {
      seed: 0, evaluationLimit: 1, evaluations: 0, acceptedMoves: 0, routingAttempts: 0,
      initialWireLength: 0, finalWireLength: 0, outline: { width: 50, height: 50 },
      diagnostics: { timingsMs: { setup: 0, layout: 0, routing: 0, power: 0, supply: 0, finalization: 0 },
        layoutChecks: 0, feasibleLayouts: 0, fullyRoutedAttempts: 0,
        rejectionCounts: { routing: 0, power: 0, supply: 0, circulation: 0 }, rejections: [], omittedRejectionDetails: 0 },
    };
    new CompactLayoutSearch(registry, network, [], statistics).applyBest();
    return statistics.diagnostics!.lastLayout!.issues.filter(issue => issue.kind === "environment-coverage");
  };
  expect(evaluate()).not.toEqual([]);
  const nearby = createRecipeNode(registry, recipe, "nearby", 6, "environment");
  nearby.entity.position = { x: 12, y: 7 }; network.nodes.push(nearby);
  expect(evaluate()).toEqual([]);
});

it("主产线已选的自产路线增加负载，保留既有实体和原目标", () => {
  const registry = createRegistryContract(), original = request();
  const recipe = registry.queries.findRecipeDefinition("liquid_transmuter_1_gas_gas_acid_1")!;
  const plan = { ...original.plan, targets: [...original.plan.targets, { itemId: "item_gas_acid", perMinute: 12 }],
    recipes: [...original.plan.recipes, { recipeId: recipe.id, deviceCount: 1, cyclesPerMinute: 12,
      inputs: [{ itemId: "item_liquid_acid", perMinute: 12 }], outputs: [{ itemId: "item_gas_acid", perMinute: 12 }],
      runningInputs: [{ itemId: "item_liquid_xiranite", perMinute: 6 }] }] };
  const network = createProductionNetwork(registry, { ...original, plan });
  const producer = network.nodes.find(node => node.recipe?.id === recipe.id)!;
  const previousId = producer.entity.id;
  supplyAuxiliaryDemand(registry, network, "item_gas_acid", 6);
  expect(network.nodes).toHaveLength(2);
  expect(producer).toMatchObject({ purpose: "production", entity: { id: previousId },
    outputs: [{ itemId: "item_gas_acid", perMinute: 18 }] });
  expect(network.request.plan.targets).toEqual(plan.targets);
  expect(plan.recipes.at(-1)!.cyclesPerMinute).toBe(12);
});
