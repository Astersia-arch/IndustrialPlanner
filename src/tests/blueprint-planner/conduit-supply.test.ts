// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createProductionNetwork } from "@/blueprint-planner/production-network";
import { PlannerPlacement } from "@/blueprint-planner/placement";
import { addTerminals } from "@/blueprint-planner/terminals";
import input from "./fixtures/environment-supply.json";

describe("EDA 暗管仓库无限供料", () => {
  it.each([
    { perMinute: 60, definitionId: "udpipe_unloader_1" },
    { perMinute: 240, definitionId: "udpipe_unloader_2" },
  ])("$definitionId：液体、气体均通过仓库链接供料，无本地库存或场景覆盖", ({ perMinute, definitionId }) => {
    const registry = createRegistryContract();
    const flows = ["item_liquid_acid", "item_gas_copper_enr"].map(itemId => ({ itemId, perMinute }));
    const base = structuredClone(input) as BlueprintPlannerRequest;
    const request: BlueprintPlannerRequest = { ...base, plan: { ...base.plan,
      recipes: [], targets: flows, externalSupplies: flows, supplyPolicies: [] } };
    const network = createProductionNetwork(registry, request);
    addTerminals(registry, network, new PlannerPlacement(registry, 80, 8, 2));
    const sources = network.nodes.filter(node => node.purpose === "supply");
    expect(sources).toHaveLength(2);
    expect(new Set(network.slotLinks.map(link => link.id)).size).toBe(2);
    for (const source of sources) {
      expect(source.definition.id).toBe(definitionId);
      expect(source.entity.config).toEqual({ "storageSlotGroups[0].slots[0].ignoreStock": true });
      expect(network.slotLinks.filter(link => link.source.entityId === source.entity.id)).toEqual([{
        id: expect.any(String), linkType: "share-all",
        source: { entityId: source.entity.id, storageSlotGroupId: "unloader_buffer", slotId: "slot_1" },
        target: { entityId: "warehouse", storageSlotGroupId: "warehouse", slotId: source.outputs[0]!.itemId },
      }]);
      expect(network.initialSlots.filter(slot => slot.entityId === source.entity.id)).toEqual([]);
    }
  });
});
