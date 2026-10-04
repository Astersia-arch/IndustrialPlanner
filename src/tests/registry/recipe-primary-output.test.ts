import { describe, expect, it } from "vitest";

import { createRegistryContract } from "@/registry";

describe("配方主要产物图标", () => {
  it("所有主要产物都引用可查询的真实物品", () => {
    const registry = createRegistryContract();

    for (const recipe of registry.recipeDefinitions) {
      for (const itemId of recipe.primaryOutputs ?? []) {
        expect(registry.queries.findItemDefinition(itemId), `${recipe.id}: ${itemId}`)
          .not.toBeNull();
      }
    }
  });

  it.each([
    ["r_crusher_originium_powder_basic", "item_originium_powder"],
    ["r_chrono_liquid_furnace_refined_copper_from_copper_ore_basic", "item_copper_nugget"],
  ])("固定产物配方 %s 保留首个产物图标", (recipeId, itemId) => {
    const recipe = createRegistryContract().queries.findRecipeDefinition(recipeId);

    expect(recipe?.primaryOutputs).toEqual([itemId]);
  });

  it("没有产物的配方不生成主要产物图标", () => {
    const recipe = createRegistryContract().queries.findRecipeDefinition(
      "r_chrono_wastewater_treatment_void_wastewater_basic",
    );

    expect(recipe).toMatchObject({ outputs: [], primaryOutputs: [] });
  });
});
