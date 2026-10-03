import type { BlueprintPlannerProductionPlan, BlueprintPlannerSupplyPolicy } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { RecipeDefinition } from "@/domain/registry/types/recipe-definition";
import { CONSUMPTION_RECIPE_TAG } from "./consumption-channel";
import { buildDeviceRunningConsumptionRecipesByMachine, resolveCompanionDeviceRunningConsumptionRecipe } from "./device-running-consumption";
import { isRecipeAvailableByActivity } from "./registry/activity-availability";
import { sortRecipesByDefaultPriority } from "./registry/recipe-visibility";

export interface PlannerSupplyRow {
  readonly itemId: string;
  readonly policy: BlueprintPlannerSupplyPolicy | null;
  readonly inherited: boolean;
  readonly recipes: readonly RecipeDefinition[];
  readonly parents: readonly string[];
  readonly operating: boolean;
}

export interface PlannerSupplyView {
  readonly environments: readonly { readonly itemId: string; readonly deviceCount: number }[];
  readonly rows: readonly PlannerSupplyRow[];
  readonly issues: readonly { readonly kind: "cycle" | "unavailable"; readonly itemIds: readonly string[] }[];
}

/** App 的路线预览与 EDA 的实际补料共用规则，避免界面展示一条路线而 Worker 选择另一条。 */
export class PlannerSupplyRules {
  private readonly policies = new Map<string, BlueprintPlannerSupplyPolicy>();
  private readonly external: Set<string>;
  private readonly selected = new Map<string, RecipeDefinition[]>();
  private readonly recipesByItem = new Map<string, RecipeDefinition[]>();
  private readonly defaultRecipes = new Map<string, RecipeDefinition>();
  private readonly consumption: ReturnType<typeof buildDeviceRunningConsumptionRecipesByMachine>;

  constructor(private readonly registry: RegistryContract, private readonly plan: BlueprintPlannerProductionPlan) {
    this.external = new Set([...plan.infiniteItemIds, ...plan.externalSupplies.map(flow => flow.itemId)]);
    this.consumption = buildDeviceRunningConsumptionRecipesByMachine(registry.recipeDefinitions);
    const available = sortRecipesByDefaultPriority(registry.recipeDefinitions.filter(recipe =>
      !recipe.tags.includes(CONSUMPTION_RECIPE_TAG) && !recipe.tags.includes("自然资源采集")
      && !recipe.gasDiffusionOutput && isRecipeAvailableByActivity(recipe, plan.activeActivityIds)
      && !recipe.machineId.startsWith("cheat_")
      && !registry.queries.findEntityDefinition(recipe.machineId)?.placementBehaviors.some(behavior => behavior.type === "snap-to-outer-ring-edge")));
    for (const recipe of available) for (const output of recipe.outputs) if (output.amount > 0) {
      const list = this.recipesByItem.get(output.itemId) ?? [];
      list.push(recipe); this.recipesByItem.set(output.itemId, list);
    }
    for (const entry of plan.recipes) {
      const recipe = registry.queries.findRecipeDefinition(entry.recipeId);
      if (!recipe || recipe.gasDiffusionOutput) continue;
      if (recipe.tags.includes("自然资源采集")) {
        for (const output of recipe.outputs) this.external.add(output.itemId);
      } else for (const output of recipe.outputs) {
        const list = this.selected.get(output.itemId) ?? [];
        if (!list.some(other => other.id === recipe.id)) list.push(recipe);
        this.selected.set(output.itemId, list);
      }
    }
    if (plan.supplyPolicies !== undefined && !Array.isArray(plan.supplyPolicies)) throw new Error("供料规则必须为数组。");
    for (const policy of plan.supplyPolicies ?? []) {
      if (!policy || typeof policy.itemId !== "string" || registry.queries.findItemDefinition(policy.itemId) === null
        || this.policies.has(policy.itemId) || !["external", "production"].includes(policy.source)) throw new Error("供料规则包含无效或重复的物品。");
      if (policy.source === "production" && !this.recipesByItem.get(policy.itemId)?.some(recipe => recipe.id === policy.recipeId)) {
        throw new Error(`供料规则的生产配方不可用：${policy.itemId}`);
      }
      // 原方案的加工路线与供给边界优先，新增规则只能补充尚未确定的来源。
      const selected = this.selected.get(policy.itemId);
      if (selected?.length && (policy.source !== "production" || !selected.some(recipe => recipe.id === policy.recipeId))) {
        throw new Error(`供料规则不能更换原产线配方：${policy.itemId}`);
      }
      if (!selected?.length && this.external.has(policy.itemId) && policy.source !== "external") {
        throw new Error(`供料规则不能更换原产线外供：${policy.itemId}`);
      }
      this.policies.set(policy.itemId, policy);
    }
    const costs = new Map<string, number>();
    for (const item of registry.itemDefinitions) {
      const policy = this.policies.get(item.id);
      if (policy?.source === "external" || this.selected.has(item.id)
        || (policy?.source !== "production" && (this.external.has(item.id) || item.tags.includes("自然资源")))) costs.set(item.id, 0);
    }
    // 默认路线只从已知来源正成本展开，工作消耗和环境要求同样参与可达性，避免选中自启动死循环。
    for (let pass = 0; pass < available.length; pass++) {
      let changed = false;
      for (const recipe of available) {
        const cost = 1 + this.dependencies(recipe).reduce((sum, input) => sum + (costs.get(input.itemId) ?? Infinity), 0);
        if (!Number.isFinite(cost)) continue;
        for (const output of recipe.outputs) {
          const policy = this.policies.get(output.itemId);
          if (policy?.source === "production" && policy.recipeId !== recipe.id) continue;
          if (output.amount <= 0 || cost >= (costs.get(output.itemId) ?? Infinity)) continue;
          costs.set(output.itemId, cost); this.defaultRecipes.set(output.itemId, recipe); changed = true;
        }
      }
      if (!changed) break;
    }
  }

  resolve(itemId: string): Omit<PlannerSupplyRow, "parents" | "operating"> {
    const recipes = this.recipesByItem.get(itemId) ?? [];
    const selected = this.selected.get(itemId);
    const inherited = Boolean(selected?.length) || this.external.has(itemId);
    const explicit = this.policies.get(itemId);
    if (explicit) return { itemId, policy: explicit, inherited, recipes };
    if (selected?.length) return { itemId, policy: { itemId, source: "production", recipeId: selected[0]!.id }, inherited, recipes };
    if (this.external.has(itemId) || this.registry.queries.findItemDefinition(itemId)?.tags.includes("自然资源")) {
      return { itemId, policy: { itemId, source: "external" }, inherited, recipes };
    }
    const recipe = this.defaultRecipes.get(itemId) ?? recipes[0];
    return { itemId, policy: recipe ? { itemId, source: "production", recipeId: recipe.id } : null, inherited, recipes };
  }

  dependencies(recipe: RecipeDefinition): readonly { readonly itemId: string; readonly operating: boolean }[] {
    const consumption = resolveCompanionDeviceRunningConsumptionRecipe(recipe, this.consumption);
    return [
      ...recipe.inputs.map(input => ({ itemId: input.itemId, operating: false })),
      ...(consumption?.inputs ?? []).map(input => ({ itemId: input.itemId, operating: true })),
      ...(recipe.requiredGasDiffusion ? [{ itemId: recipe.requiredGasDiffusion, operating: true }] : []),
    ];
  }

  view(): PlannerSupplyView {
    const environments = new Map<string, number>();
    for (const entry of this.plan.recipes) {
      const recipe = this.registry.queries.findRecipeDefinition(entry.recipeId);
      if (recipe?.requiredGasDiffusion) environments.set(recipe.requiredGasDiffusion,
        (environments.get(recipe.requiredGasDiffusion) ?? 0) + Math.ceil(entry.deviceCount - 1e-6));
      if (recipe?.gasDiffusionOutput && !environments.has(recipe.gasDiffusionOutput.gasItemId)) environments.set(recipe.gasDiffusionOutput.gasItemId, 0);
    }
    const rows = new Map<string, PlannerSupplyRow>();
    const issues: PlannerSupplyView["issues"][number][] = [];
    const visit = (itemId: string, path: readonly string[], operating: boolean) => {
      const resolved = this.resolve(itemId);
      if (path.includes(itemId)) {
        issues.push({ kind: "cycle", itemIds: [...path.slice(path.indexOf(itemId)), itemId] }); return;
      }
      const previous = rows.get(itemId);
      if (previous) {
        rows.set(itemId, { ...previous, parents: [...new Set([...previous.parents, ...path.slice(-1)])], operating: previous.operating || operating });
        return;
      }
      rows.set(itemId, { ...resolved, parents: path.slice(-1), operating });
      if (!resolved.policy) { issues.push({ kind: "unavailable", itemIds: [itemId] }); return; }
      if (resolved.policy.source === "external" || resolved.inherited) return;
      const recipe = this.registry.queries.findRecipeDefinition(resolved.policy.recipeId)!;
      if (recipe.requiredGasDiffusion && !environments.has(recipe.requiredGasDiffusion)) environments.set(recipe.requiredGasDiffusion, 0);
      for (const input of this.dependencies(recipe)) visit(input.itemId, [...path, itemId], input.operating);
    };
    for (const itemId of environments.keys()) visit(itemId, [], false);
    return { environments: [...environments].map(([itemId, deviceCount]) => ({ itemId, deviceCount })), rows: [...rows.values()], issues };
  }
}
