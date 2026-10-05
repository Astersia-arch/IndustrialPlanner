// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { PlannerSupplyRules } from "@/shared/planner-supply";
import input from "../blueprint-planner/fixtures/environment-supply.json";

const request = () => structuredClone(input) as BlueprintPlannerRequest;

describe("环境供料的共享规则", () => {
  it("没有散布机数量仍能识别环境、自产路线和运行供料，原计划不变", () => {
    const plan = request().plan, before = JSON.stringify(plan);
    const view = new PlannerSupplyRules(createRegistryContract(), plan).view();
    expect(view.environments).toEqual([{ itemId: "item_gas_acid", deviceCount: 1 }]);
    expect(view.rows.map(row => row.itemId)).toEqual(["item_gas_acid", "item_liquid_acid", "item_liquid_xiranite"]);
    expect(view.rows.find(row => row.itemId === "item_liquid_xiranite")?.operating).toBe(true);
    expect(view.issues).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("切换外供后不再要求自产上游；不隐式改变主产线来源", () => {
    const plan = request().plan;
    const rules = new PlannerSupplyRules(createRegistryContract(), { ...plan,
      supplyPolicies: [{ itemId: "item_gas_acid", source: "external" }] });
    expect(rules.view().rows.map(row => row.itemId)).toEqual(["item_gas_acid"]);
    expect(rules.resolve("item_gas_xiranite")).toMatchObject({ inherited: true, policy: { source: "external" } });
    expect(() => new PlannerSupplyRules(createRegistryContract(), { ...plan,
      supplyPolicies: [{ itemId: "item_gas_xiranite", source: "production", recipeId: "liquid_transmuter_2_gas_gas_xiranite_1" }] })).toThrow("不能更换原产线外供");
  });

  it("默认补料绕开需要自身启动物料的路线；手选循环时给出完整路径", () => {
    const plan = { ...request().plan, supplyPolicies: [] };
    const registry = createRegistryContract(), view = new PlannerSupplyRules(registry, plan).view();
    expect(view.issues).toEqual([]);
    expect(view.rows.find(row => row.itemId === "item_liquid_xiranite")?.policy).toMatchObject({ recipeId: "r_mix_pool_liquid_xiranite_from_xiranite_powder_and_water_basic" });
    const cyclic = new PlannerSupplyRules(registry, { ...plan,
      supplyPolicies: [{ itemId: "item_liquid_xiranite", source: "production", recipeId: "liquid_transmuter_1_liquid_liquid_xiranite_1" }] });
    // AI-REMOVED 2026-10-05:
    // Reason: 可自持的运行耗材自循环改为独立的启动策略诊断。
    // Trigger: 用户授权三种转化设备启动方式。Evidence: PlannerSupplyRules.selfConsumption。
    // Replacement: 下方 startup 断言。Risk: Low；普通循环仍拒绝。Human Review: Required
    // Original code:
    // expect(cyclic.view().issues).toContainEqual({ kind: "cycle", itemIds: ["item_liquid_xiranite", "item_liquid_xiranite"] });
    expect(cyclic.view().issues).toContainEqual({ kind: "startup", itemIds: ["item_liquid_xiranite"] });
  });

  it.each(["manual", "tank"] as const)("%s 只允许正净产出的耗材自循环，普通供料环仍拒绝", mode => {
    const registry = createRegistryContract();
    const plan = { ...request().plan, supplyPolicies: [
      { itemId: "item_liquid_xiranite", source: "production" as const, recipeId: "liquid_transmuter_1_liquid_liquid_xiranite_1" },
    ] };
    const view = new PlannerSupplyRules(registry, plan, mode).view();
    expect(view.issues).toEqual([]);
    expect(view.startupItemIds).toEqual(["item_liquid_xiranite"]);
    const cyclic = { ...plan, externalSupplies: plan.externalSupplies.filter(flow => flow.itemId !== "item_gas_xiranite"),
      supplyPolicies: [...plan.supplyPolicies, { itemId: "item_gas_xiranite", source: "production" as const, recipeId: "liquid_transmuter_1_gas_gas_xiranite_1" }] };
    expect(new PlannerSupplyRules(registry, cyclic, mode).view().issues.some(issue => issue.kind === "cycle")).toBe(true);
    Object.assign(registry.queries.findRecipeDefinition("liquid_transmuter_1_liquid_liquid_xiranite_1")!, { durationSeconds: 12 });
    expect(new PlannerSupplyRules(registry, plan, mode).view().issues.some(issue => issue.kind === "cycle")).toBe(true);
  });

  it("拒绝无效、重复和不能产出目标物品的规则", () => {
    const plan = request().plan, registry = createRegistryContract();
    expect(() => new PlannerSupplyRules(registry, { ...plan, supplyPolicies: [
      { itemId: "item_gas_acid", source: "external" }, { itemId: "item_gas_acid", source: "external" },
    ] })).toThrow("重复");
    expect(() => new PlannerSupplyRules(registry, { ...plan, supplyPolicies: [
      { itemId: "item_gas_acid", source: "production", recipeId: "gas_reactor_gas_copper_enr2_1" },
    ] })).toThrow("生产配方不可用");
  });
});
