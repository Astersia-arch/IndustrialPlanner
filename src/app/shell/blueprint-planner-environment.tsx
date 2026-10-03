import { useMemo } from "react";
import type { BlueprintPlannerProductionPlan, BlueprintPlannerSupplyPolicy } from "@/domain/blueprint-planner";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import type { RecipeDefinition } from "@/domain/registry/types/recipe-definition";
import { createItemIconAssetUrl } from "@/shared/browser/public-asset-url";
import { PlannerSupplyRules, type PlannerSupplyView, type PlannerSupplyRow } from "@/shared/planner-supply";
import { ProductionPlanningTreeTableView, RecipeChoiceControls, buildProductionPlanningIndex,
  resolveProductionPlanningRecipeName, type PlanningTreeRow } from "./production-planning";
import { RecipeDisplay } from "./shared/recipe-display";
import { cm } from "./shared";
import treeStyles from "./app-shell.module.scss";
import styles from "./blueprint-planner-dialog.module.scss";

interface EnvironmentTreeRow extends PlanningTreeRow { readonly supply: PlannerSupplyRow; }

export function buildEnvironmentTreeRows(view: PlannerSupplyView): readonly EnvironmentTreeRow[] {
  const rows: EnvironmentTreeRow[] = [];
  const expanded = new Set<string>();
  const append = (supply: PlannerSupplyRow, parent: EnvironmentTreeRow | null) => {
    const id = parent ? `${parent.id}/${supply.itemId}` : supply.itemId;
    const childIds: string[] = [];
    const row: EnvironmentTreeRow = { id, supply, depth: parent ? parent.depth + 1 : 0,
      parentIds: parent ? [parent.id] : [], childIds, isShared: supply.parents.length > 1 || expanded.has(supply.itemId) };
    rows.push(row);
    if (expanded.has(supply.itemId)) return;
    expanded.add(supply.itemId);
    for (const child of view.rows.filter(entry => entry.parents.includes(supply.itemId))) {
      childIds.push(`${id}/${child.itemId}`); append(child, row);
    }
  };
  for (const root of view.environments) {
    const supply = view.rows.find(row => row.itemId === root.itemId);
    if (supply && !expanded.has(supply.itemId)) append(supply, null);
  }
  for (const supply of view.rows) if (!expanded.has(supply.itemId)) append(supply, null);
  return rows;
}

export function BlueprintPlannerEnvironment({ plan, registry, view, disabled, isTouch, onChange, onPickRecipe, t }: {
  readonly plan: BlueprintPlannerProductionPlan;
  readonly registry: RegistryContract;
  readonly view: PlannerSupplyView;
  readonly disabled: boolean;
  readonly isTouch: boolean;
  readonly onChange: (policy: BlueprintPlannerSupplyPolicy) => void;
  readonly onPickRecipe: (itemId: string, recipes: readonly RecipeDefinition[]) => void;
  readonly t: (key: string) => string;
}) {
  const index = useMemo(() => buildProductionPlanningIndex(registry, {
    includeInactiveActivityContent: false, activeActivityIds: plan.activeActivityIds,
  }), [registry, plan.activeActivityIds]);
  const rows = useMemo(() => buildEnvironmentTreeRows(view), [view]);
  if (!view.environments.length) return null;
  const itemName = (id: string) => {
    const item = registry.queries.findItemDefinition(id);
    return item ? t(item.nameKey) : id;
  };
  const recipeName = (row: PlannerSupplyRow) => row.policy?.source === "production"
    ? resolveProductionPlanningRecipeName(registry.queries.findRecipeDefinition(row.policy.recipeId)!, index, t) : t(row.policy ? "eda.supplyExternal" : "eda.supplyUnspecified");
  const chooseProduction = (row: PlannerSupplyRow, candidateId: string | null = null) => {
    const selected = candidateId ? index.candidateById.get(candidateId)?.recipeId : null;
    const fallback = new PlannerSupplyRules(registry, { ...plan,
      supplyPolicies: plan.supplyPolicies?.filter(policy => policy.itemId !== row.itemId) }).resolve(row.itemId).policy;
    const recipeId = selected ?? (fallback?.source === "production" ? fallback.recipeId : row.recipes[0]?.id);
    if (recipeId) onChange({ itemId: row.itemId, source: "production", recipeId });
  };
  const identity = (row: PlannerSupplyRow) => <div className={cm(treeStyles, "production-planning-recipe-identity")}>
    <img src={createItemIconAssetUrl(registry.queries.findItemDefinition(row.itemId)?.iconId ?? row.itemId)} alt="" />
    <div><strong>{itemName(row.itemId)}</strong><span>{recipeName(row)}</span></div>
  </div>;
  return <section className={styles.environment} aria-label={t("eda.environmentSupply")}>
    <div className={styles.environmentHeading}><strong>{t("eda.environmentSupply")}</strong><span>{t("eda.environmentAutomatic")}</span></div>
    <div className={styles.environmentRequirements}>
      {view.environments.map(environment => <div key={environment.itemId}>
        <span>{t("eda.environmentName").replace("{gas}", itemName(environment.itemId))}</span>
        {environment.deviceCount > 0 ? <span>{t("eda.environmentDevices").replace("{count}", String(environment.deviceCount))}</span> : null}
      </div>)}
    </div>
    <div className={styles.environmentTree}>
      <ProductionPlanningTreeTableView rows={rows} styles={treeStyles} t={t}
        renderIdentity={row => <>{identity(row.supply)}{row.isShared ? <span className={cm(treeStyles, "production-planning-tree-table-chip")}>{t("productionPlanning.shared")}</span> : null}</>}
        // AI-REMOVED 2026-10-03:
        // Reason: 未知数量的重复速率列挤压环境树的物品名称。Trigger: 平板截图检查。
        // Evidence: 711px 下树区域仅 142px，横向滚动裁掉树分支。Replacement: 节点详情的速率说明。
        // Risk: Low；量化产线仍保留速率列。Human Review: Required
        // Original code: renderRate={() => <span>{t("eda.layoutDetermined")}</span>}
        renderDetail={({ supply: row }) => <fieldset disabled={disabled} className={`${styles.environmentDetail} ${cm(treeStyles, "production-planning-tree-detail-stack is-compact")}`}>
          <div className={cm(treeStyles, "production-planning-item-detail-header")}>{identity(row)}
            {row.inherited ? <span className={styles.supplyInherited}>{t("eda.supplyInherited")}</span>
              : <button type="button" className={cm(treeStyles, "production-planning-icon-text-button")}
                disabled={row.policy?.source === "external" && !row.recipes.length}
                onClick={() => row.policy?.source !== "external" ? onChange({ itemId: row.itemId, source: "external" }) : chooseProduction(row)}>
                {row.policy?.source !== "external" ? t("eda.supplyExternal") : t("eda.supplyProduce")}
              </button>}
          </div>
          <div className={styles.supplyInherited}><span>{t("productionPlanning.rate")}</span><span>{t("eda.layoutDetermined")}</span></div>
          {!row.inherited && row.policy?.source === "production" ? <RecipeChoiceControls styles={treeStyles} itemId={row.itemId}
            recipes={row.recipes} candidates={(index.candidatesByOutputItem.get(row.itemId) ?? []).filter(candidate => row.recipes.some(recipe => recipe.id === candidate.recipeId))}
            index={index} selectedRecipeId={row.policy.recipeId} onSelectRecipe={(_, id) => chooseProduction(row, id)}
            onRequestRecipeSelection={onPickRecipe} t={t} /> : null}
          {row.policy?.source === "production" ? <RecipeDisplay recipeId={row.policy.recipeId} index={index} showDevice isTouch={isTouch} t={t} /> : null}
          {row.parents.length ? <div className={cm(treeStyles, "production-planning-tree-relations")}>
            <span>{row.operating ? t("eda.supplyOperating") : t("eda.supplyUpstream")}</span>
            <span>{row.parents.map(itemName).join("、")}</span>
          </div> : null}
        </fieldset>} />
    </div>
    {view.issues.map((issue, index) => <p key={index} role="alert" className={styles.error}>
      {issue.kind === "cycle" ? t("eda.supplyCycle").replace("{items}", issue.itemIds.map(itemName).join(" → "))
        : t("eda.supplyUnavailable").replace("{item}", itemName(issue.itemIds[0]!))}
    </p>)}
  </section>;
}

// AI-REMOVED 2026-10-03:
// Reason: 平铺供料控件与产线规划树表重复，且不能直接表达上游关系。
// Trigger: 用户要求复用产线规划树表和配方选择。
// Evidence: 原组件逐行创建独立来源及配方 select。
// Replacement: 下方 BlueprintPlannerEnvironment 使用 ProductionPlanningTreeTableView。
// Risk: Low；来源策略数据不变。
// Human Review: Required
// Original code:
// export function BlueprintPlannerEnvironment({ plan, registry, view, disabled, onChange, t }: {
//   readonly plan: BlueprintPlannerProductionPlan;
//   readonly registry: RegistryContract;
//   readonly view: PlannerSupplyView;
//   readonly disabled: boolean;
//   readonly onChange: (policy: BlueprintPlannerSupplyPolicy) => void;
//   readonly t: (key: string) => string;
// }) {
//   if (!view.environments.length) return null;
//   const itemName = (id: string) => {
//     const item = registry.queries.findItemDefinition(id);
//     return item ? t(item.nameKey) : id;
//   };
//   return <section className={styles.environment} aria-label={t("eda.environmentSupply")}>
//     <div className={styles.environmentHeading}>
//       <strong>{t("eda.environmentSupply")}</strong>
//       <span>{t("eda.environmentAutomatic")}</span>
//     </div>
//     <div className={styles.environmentRequirements}>
//       {view.environments.map(environment => <div key={environment.itemId}>
//         <span>{t("eda.environmentName").replace("{gas}", itemName(environment.itemId))}</span>
//         {environment.deviceCount > 0 ? <span>{t("eda.environmentDevices").replace("{count}", String(environment.deviceCount))}</span> : null}
//       </div>)}
//     </div>
//     <fieldset className={styles.supplyRules} disabled={disabled}>
//       {view.rows.map(row => {
//         const item = registry.queries.findItemDefinition(row.itemId);
//         const recipe = row.policy?.source === "production" ? registry.queries.findRecipeDefinition(row.policy.recipeId) : null;
//         const explicit = plan.supplyPolicies?.find(policy => policy.itemId === row.itemId);
//         const preferred = explicit?.source === "production" ? row.recipes.find(entry => entry.id === explicit.recipeId) : row.recipes[0];
//         return <div className={styles.supplyRule} key={row.itemId}>
//           <div className={styles.supplyItem}>
//             {item ? <img src={createItemIconAssetUrl(item.iconId)} alt="" /> : null}
//             <div><strong>{itemName(row.itemId)}</strong>
//               {row.parents.length ? <span>{row.operating ? t("eda.supplyOperating") : t("eda.supplyUpstream")} · {row.parents.map(itemName).join("、")}</span> : null}
//             </div>
//           </div>
//           <div className={styles.supplyControls}>
//             {row.inherited ? <div className={styles.supplyInherited}>
//               <span>{t("eda.supplyInherited")}</span><span>{recipe ? t(recipe.nameKey) : t("eda.supplyExternal")}</span>
//             </div> : <>
//               <label><span>{t("eda.supplyMode")}</span>
//                 <select aria-label={`${itemName(row.itemId)} · ${t("eda.supplyMode")}`} value={row.policy?.source ?? "production"}
//                   onChange={event => {
//                     if (event.target.value === "external") onChange({ itemId: row.itemId, source: "external" });
//                     else {
//                       const fallback = new PlannerSupplyRules(registry, { ...plan,
//                         supplyPolicies: plan.supplyPolicies?.filter(policy => policy.itemId !== row.itemId) }).resolve(row.itemId).policy;
//                       const recipeId = fallback?.source === "production" ? fallback.recipeId : preferred?.id;
//                       if (recipeId) onChange({ itemId: row.itemId, source: "production", recipeId });
//                     }
//                   }}>
//                   <option value="external">{t("eda.supplyExternal")}</option>
//                   <option value="production" disabled={!row.recipes.length}>{t("eda.supplyProduce")}</option>
//                 </select>
//               </label>
//               {row.policy?.source === "production" ? <label><span>{t("eda.supplyRecipe")}</span>
//                 <select aria-label={`${itemName(row.itemId)} · ${t("eda.supplyRecipe")}`} value={row.policy.recipeId}
//                   onChange={event => onChange({ itemId: row.itemId, source: "production", recipeId: event.target.value })}>
//                   {row.recipes.map(entry => <option key={entry.id} value={entry.id}>{t(entry.nameKey)}</option>)}
//                 </select>
//               </label> : null}
//             </>}
//           </div>
//         </div>;
//       })}
//     </fieldset>
//     {view.issues.map((issue, index) => <p key={index} role="alert" className={styles.error}>
//       {issue.kind === "cycle" ? t("eda.supplyCycle").replace("{items}", issue.itemIds.map(itemName).join(" → "))
//         : t("eda.supplyUnavailable").replace("{item}", itemName(issue.itemIds[0]!))}
//     </p>)}
//   </section>;
// }
