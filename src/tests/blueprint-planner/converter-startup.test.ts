// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createProductionNetwork, supplyAuxiliaryDemand, validatePlannerRequest } from "@/blueprint-planner/production-network";
import { materialBalance } from "@/blueprint-planner/terminals";
import { PlannerPlacement } from "@/blueprint-planner/placement";
import { prepareConverterStartups, configureConverterStartupInventory } from "@/blueprint-planner/support";
import { plannerRequestKey } from "@/blueprint-planner/search-seed";
import { createPlannerCandidate } from "@/blueprint-planner/candidate";
import { meetsOperatingLimits, meetsProductionTargets } from "@/blueprint-planner/verification";
import { BlueprintExecutionClient } from "@/simulation/blueprint";
import { createDenseBlueprintEngine } from "@/simulation/dense/blueprint-engine";
import { saveSuccessfulPlanning } from "@/scripts/eda/artifacts";
import liquid from "./fixtures/converter-startup-liquid.json";
import gas from "./fixtures/converter-startup-gas.json";

const request = (mode: "manual" | "tank" | "reject", input: BlueprintPlannerRequest = liquid as BlueprintPlannerRequest): BlueprintPlannerRequest => ({
  ...structuredClone(input) as BlueprintPlannerRequest, options: { ...input.options as BlueprintPlannerRequest["options"], converterStartup: mode },
});

describe("转化设备启动与供料配平", () => {
  it("默认拒绝，三种策略进入请求指纹，非法值不能导入", () => {
    const registry = createRegistryContract();
    expect(() => validatePlannerRequest(registry, liquid as BlueprintPlannerRequest)).toThrow("需要外部启动器启动，请调整启动设置");
    expect(() => validatePlannerRequest(registry, request("reject"))).toThrow("液化息壤 自循环");
    expect(new Set(["manual", "tank", "reject"].map(mode => plannerRequestKey(request(mode as "manual" | "tank" | "reject")))).size).toBe(3);
    expect(plannerRequestKey(liquid as BlueprintPlannerRequest)).toBe(plannerRequestKey(request("reject")));
    expect(plannerRequestKey(request("reject"))).not.toContain('"converterStartup"');
    expect(() => validatePlannerRequest(registry, { ...request("manual"), options: { ...request("manual").options,
      converterStartup: "infinite" as "manual" } })).toThrow("未知转化设备启动方式");
  });

  it("自产量包含自身耗材，跨整数设备边界增加产能而不递归补造外供", () => {
    const registry = createRegistryContract(), network = createProductionNetwork(registry, request("manual"));
    supplyAuxiliaryDemand(registry, network, "item_liquid_xiranite", 30);
    const producers = network.nodes.filter(node => node.recipe?.id === "liquid_transmuter_1_liquid_liquid_xiranite_1");
    expect(producers).toHaveLength(2);
    expect(producers.flatMap(node => node.outputs).reduce((sum, flow) => sum + flow.perMinute, 0)).toBe(42);
    expect(producers.flatMap(node => node.inputs).filter(flow => flow.itemId === "item_liquid_xiranite").reduce((sum, flow) => sum + flow.perMinute, 0)).toBe(12);
    expect(materialBalance(network).get("item_liquid_xiranite")).toBe(30);
    supplyAuxiliaryDemand(registry, network, "item_liquid_xiranite", 6);
    expect(network.nodes.filter(node => node.recipe?.id === producers[0]!.recipe!.id)).toHaveLength(2);
    expect(materialBalance(network).get("item_liquid_xiranite")).toBe(36);
  });

  it("储罐是平衡的回流节点；库存依路程设置且超容量时拒绝", () => {
    const registry = createRegistryContract(), network = createProductionNetwork(registry, request("tank"));
    supplyAuxiliaryDemand(registry, network, "item_liquid_xiranite", 6);
    const before = materialBalance(network).get("item_liquid_xiranite");
    prepareConverterStartups(registry, network, new PlannerPlacement(registry, 30, 7, 2));
    const tank = network.nodes.find(node => node.definition.id === "liquid_storager_1")!;
    expect(materialBalance(network).get("item_liquid_xiranite")).toBe(before);
    expect(tank.supplyTarget?.entityId).toBe(tank.outputSource?.entityId);
    configureConverterStartupInventory(network, () => 30);
    expect(tank.entity.config["storageSlotGroups[0].slots[0].initialCount"]).toBe(9);
    expect(tank.entity.config["storageSlotGroups[0].slots[0].ignoreStock"]).toBe(false);
    expect(() => configureConverterStartupInventory(network, () => 6000)).toThrow("启动罐容量不足");
  });
});

describe("转化设备真实回流启动", () => {
  for (const [kind, input] of [["liquid", liquid], ["gas", gas]] as const) {
    it.each(["manual", "tank"] as const)(`${kind} %s：有限库存启动，Dense 2 TPS 自持并达到净产量`, async mode => {
      const registry = createRegistryContract(), current = request(mode, input as BlueprintPlannerRequest);
      const executor = new BlueprintExecutionClient(registry, "dense-v2", "runtime", options => createDenseBlueprintEngine(registry, options), 2);
      const started = performance.now();
      try {
        const candidate = await createPlannerCandidate(registry, current, 0, () => undefined, () => undefined, { maxEvaluations: 50_000 });
        const report = await executor.run({ ...candidate.execution, maxWallTimeMs: 30_000 });
        expect(report.engineKind).toBe("dense-v2");
        expect(meetsProductionTargets(current, report)).toBe(true);
        expect(meetsOperatingLimits(candidate.supplyAudit, report)).toBe(true);
        const tank = Object.values(candidate.execution.blueprint.entities).find(entity => entity.definitionId === (kind === "gas" ? "gas_storager_1" : "liquid_storager_1"));
        if (mode === "tank") {
          expect(tank).toBeDefined();
          expect(tank!.config["storageSlotGroups[0].slots[0].initialCount"]).toBeLessThan(500);
          expect(candidate.execution.scene.scheduledSlots).toEqual([]);
        } else {
          expect(tank).toBeUndefined();
          const schedules = candidate.execution.scene.scheduledSlots!;
          expect(schedules).toHaveLength(candidate.supplyAudit.startupProduction!.length);
          expect(new Set(schedules.map(entry => entry.patch.entityId)).size).toBe(schedules.length);
          for (const entry of schedules) {
            expect(entry.simulationSeconds).toBeGreaterThan(0);
            expect(entry.simulationSeconds).toBeLessThan(candidate.execution.warmupSeconds);
            expect(entry.patch.count).toBe(5);
            expect(entry.patch.ignoreStock).toBe(false);
            const producer = candidate.execution.blueprint.entities[entry.patch.entityId]!;
            const groupIndex = registry.queries.findEntityDefinition(producer.definitionId)!.storageSlotGroups
              .findIndex(group => group.id === entry.patch.storageGroupId);
            expect(producer.config[`storageSlotGroups[${groupIndex}].slots[0].initialCount`] ?? 0).toBe(0);
          }
          const withoutStartup = await executor.run({ ...candidate.execution,
            scene: { ...candidate.execution.scene, scheduledSlots: [] }, maxWallTimeMs: 30_000 });
          expect(meetsProductionTargets(current, withoutStartup)).toBe(false);
          expect(meetsOperatingLimits(candidate.supplyAudit, withoutStartup)).toBe(false);
        }
        expect(candidate.execution.scene.initialSlots.some(slot => slot.storageGroupId === "consume_buffer")).toBe(false);
        expect(meetsOperatingLimits(candidate.supplyAudit, { ...report, probes: report.probes.map(probe =>
          probe.id.startsWith("startup:") ? { ...probe, perMinute: 0 } : probe) })).toBe(false);
        await saveSuccessfulPlanning(registry, `转化自循环-${kind}-${mode}`, candidate.execution.blueprint, current,
          { elapsedMs: performance.now() - started, metrics: candidate.metrics, report });
      } finally { executor.dispose(); }
    }, 60_000);
  }
});
