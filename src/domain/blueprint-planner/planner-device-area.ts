/**
 * 默认面积上界的推算。
 *
 * 口径（2026-10-07 上游维护者确认）：
 *   初始面积上界不作为用户可调项暴露，未指定时直接取「设备面积 × 2」。
 *   设备面积 = 所有产线设备 footprint 面积按其台数累加（台数允许小数，按吞吐折算）。
 *   实测 yazhen 夹具设备面积 137 格，× 2 = 274，与人工最优蓝图 270 格同量级。
 *
 * 维护者原话：「初始面积上限不是一个好选项，这个选项不应该暴露给用户。
 * 不是什么都要让用户去调。这个直接设置为2倍设备面积就好。所以这个改动我不会接受。」
 *
 * 例外：原蓝图优化任务的 plan.recipes 为空（见 blueprint-network.ts），拿不到任何设备信息，
 * 此时必须**不施加**默认上限，交回既有的「区域可放置面积 + 已证最优面积收缩」逻辑；
 * 把 0 当成可行上界会让尺寸枚举为空，反而破坏已有蓝图的压缩。
 */

import type { RegistryContract } from "../registry/registry-contract";
import type { BlueprintPlannerProductionPlan } from "./types/blueprint-planner-types";

/** 默认面积上界的倍数：设备面积的两倍。 */
export const PLANNER_DEFAULT_AREA_DEVICE_MULTIPLE = 2;

/**
 * 产线设备本体占用的格数；返回 0 表示这份方案里解析不出任何设备。
 *
 * 调用方不得把 0 当作可行上界：原蓝图优化任务的 plan.recipes 为空，此处必然为 0，
 * 而 0 会让搜索的尺寸枚举为空。见文件头部的例外说明。
 */
export function resolvePlannerDeviceArea(registry: RegistryContract, plan: BlueprintPlannerProductionPlan): number {
  let deviceCells = 0;
  for (const entry of plan.recipes) {
    const recipe = registry.queries.findRecipeDefinition(entry.recipeId);
    const definition = recipe === null ? null : registry.queries.findEntityDefinition(recipe.machineId);
    if (definition) deviceCells += definition.footprint.width * definition.footprint.height * entry.deviceCount;
  }
  // 订正 2026-10-06（CI 的 9 项失败暴露）：plan 允许小数 deviceCount（按吞吐折算的台数，
  // 实测 fixture 里有 0.5 / 0.75），直接累加会得到小数格数；该值充当搜索面积上界时会被
  // continuationOutline 的正整数校验抛错（"面积上限必须是正整数。"），整轮规划直接失败。
  // 格数是整数物理量：实际必然放置整数台设备，故对累加结果向上取整仍然是不超过实际的下界。
  return Math.ceil(deviceCells);
}

// AI-REMOVED 2026-10-07:
// Reason: 上游维护者否决了「面积上界可由用户指定」，并要求默认上界改为 2 倍设备面积；
//         「理论面积 = 设备 + 连接线」（并以其 3 倍作为默认上界）这套口径随之废弃。
// Trigger: PR #34 评审意见；其中「默认面积上限破坏原蓝图优化」是实测复现的真实缺陷：
//          原蓝图优化任务的 plan.recipes 为空，该函数返回 deviceCells=0、linkCells=1、
//          totalCells=1，× 3 = 3 格上限，低于固定设施最小盒 5×5 = 25 格，尺寸枚举为空。
// Evidence: 探针实测 yazhen 夹具 deviceCells=137 / linkCells=13 / totalCells=150（× 3 = 450）；
//           原蓝图任务（recipes=[]）deviceCells=0 / totalCells=1（× 3 = 3）< 最小盒 25；
//           CI 与本地失败的 9 项亦由该口径下的小数上界触发。
// Replacement: 本文件的 resolvePlannerDeviceArea + PLANNER_DEFAULT_AREA_DEVICE_MULTIPLE，
//              并由 blueprint-planner-host.ts 在设备面积为 0 时跳过默认上界。
// Risk: 默认上界由「理论面积 × 3」收紧为「设备面积 × 2」，对设备极少、环境设施极多的方案可能偏紧；
//       已用 max(设备面积 × 2, 固定设施最小盒面积) 兜住「枚举为空」这一下限。
// Human Review: Required
//
// Original code:
// /**
//  * 生产方案的理论面积下界。
//  *
//  * 口径（2026-10-06 用户确认）：
//  *   理论面积 = 产线设备本体占用 + 连接线（传送带 / 管道）数量
//  *
//  * 它服务两个用途：
//  *   1. 界面在面积上界输入旁标注下界，让用户填数前知道再小也不可能小于这个值；
//  *   2. 未显式指定上界时，作为默认建议上界的基数（理论面积 × 3，再与基地可放置面积取小）。
//  *
//  * 这是**下界估算**而非可达面积：
//  *   · 设备本体按 footprint 面积计，同型号设备按其数量累加；
//  *   · 连接线按"每条至少占 1 格"计。真实的物流线会因绕行、缓冲与分叉远长于这个数，
//  *     所以可交付面积必然大于本值——这也是它只能当"下界"而不能当目标的原因。
//  *   · 不含环境气体散布机、仓库口、输出设备与启动源；这些由规划器按实际环境补齐。
//  */
//
// export interface PlannerTheoreticalArea {
//   /** 产线设备本体占用（格）。 */
//   readonly deviceCells: number;
//   /** 连接线数量下界（每条按 1 格计）。 */
//   readonly linkCells: number;
//   /** 两者之和。 */
//   readonly totalCells: number;
// }
//
// export function resolvePlannerTheoreticalArea(
//   registry: RegistryContract,
//   plan: BlueprintPlannerProductionPlan,
// ): PlannerTheoreticalArea {
//   let deviceCells = 0;
//   let sinkFlows = 0;
//   let sourceFlows = 0;
//   for (const entry of plan.recipes) {
//     const recipe = registry.queries.findRecipeDefinition(entry.recipeId);
//     const definition = recipe === null ? null : registry.queries.findEntityDefinition(recipe.machineId);
//     if (definition) deviceCells += definition.footprint.width * definition.footprint.height * entry.deviceCount;
//     sinkFlows += entry.inputs.length * entry.deviceCount;
//     sourceFlows += entry.outputs.length * entry.deviceCount;
//   }
//   // 订正 2026-10-06（CI 的 9 项失败暴露）：plan 允许小数 deviceCount（按吞吐折算的台数，
//   // 实测 fixture 里有 0.5 / 0.75），直接累加会得到小数格数。该值乘 PLANNER_DEFAULT_AREA_LIMIT_MULTIPLE
//   // 充当搜索面积上界时，被 continuationOutline 的正整数校验抛错（"面积上限必须是正整数。"），
//   // 整轮规划直接失败——task-sharding 5 项、task-checkpoint 2 项、checkpoint-memory 2 项即此因。
//   // 格数是整数物理量：实际必然放置整数台设备、整数条连接线，故对累加结果向上取整仍然是不超过实际的下界。
//   const resolvedDeviceCells = Math.ceil(deviceCells);
//   // 设备之间的一条线同时是上游的输出与下游的输入，所以取两者较大者即可覆盖设备间物流，
//   // 不再相加（相加会把同一条线算两次）；再补上对外接口：外部供给每个入口一条、目标产物每个出口一条。
//   const linkCells = Math.ceil(Math.max(sinkFlows, sourceFlows) + plan.externalSupplies.length + plan.targets.length);
//   return { deviceCells: resolvedDeviceCells, linkCells, totalCells: resolvedDeviceCells + linkCells };
// }
//
// /** 默认建议上界的倍数：理论面积的三倍。用户显式指定上界时不使用它。 */
// export const PLANNER_DEFAULT_AREA_LIMIT_MULTIPLE = 3;
