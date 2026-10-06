/**
 * 生产方案的理论面积下界。
 *
 * 口径（2026-10-06 用户确认）：
 *   理论面积 = 产线设备本体占用 + 连接线（传送带 / 管道）数量
 *
 * 它服务两个用途：
 *   1. 界面在面积上界输入旁标注下界，让用户填数前知道再小也不可能小于这个值；
 *   2. 未显式指定上界时，作为默认建议上界的基数（理论面积 × 3，再与基地可放置面积取小）。
 *
 * 这是**下界估算**而非可达面积：
 *   · 设备本体按 footprint 面积计，同型号设备按其数量累加；
 *   · 连接线按"每条至少占 1 格"计。真实的物流线会因绕行、缓冲与分叉远长于这个数，
 *     所以可交付面积必然大于本值——这也是它只能当"下界"而不能当目标的原因。
 *   · 不含环境气体散布机、仓库口、输出设备与启动源；这些由规划器按实际环境补齐。
 */

import type { RegistryContract } from "../registry/registry-contract";
import type { BlueprintPlannerProductionPlan } from "./types/blueprint-planner-types";

export interface PlannerTheoreticalArea {
  /** 产线设备本体占用（格）。 */
  readonly deviceCells: number;
  /** 连接线数量下界（每条按 1 格计）。 */
  readonly linkCells: number;
  /** 两者之和。 */
  readonly totalCells: number;
}

export function resolvePlannerTheoreticalArea(
  registry: RegistryContract,
  plan: BlueprintPlannerProductionPlan,
): PlannerTheoreticalArea {
  let deviceCells = 0;
  let sinkFlows = 0;
  let sourceFlows = 0;
  for (const entry of plan.recipes) {
    const recipe = registry.queries.findRecipeDefinition(entry.recipeId);
    const definition = recipe === null ? null : registry.queries.findEntityDefinition(recipe.machineId);
    if (definition) deviceCells += definition.footprint.width * definition.footprint.height * entry.deviceCount;
    sinkFlows += entry.inputs.length * entry.deviceCount;
    sourceFlows += entry.outputs.length * entry.deviceCount;
  }
  // 设备之间的一条线同时是上游的输出与下游的输入，所以取两者较大者即可覆盖设备间物流，
  // 不再相加（相加会把同一条线算两次）；再补上对外接口：外部供给每个入口一条、目标产物每个出口一条。
  const linkCells = Math.max(sinkFlows, sourceFlows) + plan.externalSupplies.length + plan.targets.length;
  return { deviceCells, linkCells, totalCells: deviceCells + linkCells };
}

/** 默认建议上界的倍数：理论面积的三倍。用户显式指定上界时不使用它。 */
export const PLANNER_DEFAULT_AREA_LIMIT_MULTIPLE = 3;
