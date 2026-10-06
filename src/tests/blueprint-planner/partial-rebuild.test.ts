// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createPlainNode } from "@/blueprint-planner/placement";
import { constructCompactLayout } from "@/blueprint-planner/constructive-layout";
import { CompactLayoutSearch } from "@/blueprint-planner/compact-layout";
import type { PlannerSearchStatistics } from "@/blueprint-planner/search-types";
import type { PlannerNetwork } from "@/blueprint-planner/model";
import yazhen from "./fixtures/yazhen-syringe.json";

it("部分重建保持未选设备及原输入，超预算中断不提交半成品", () => {
  const registry = createRegistryContract();
  const a = createPlainNode(registry, "belt_straight_1x1", "anchor", "logistics");
  const b = createPlainNode(registry, "belt_straight_1x1", "moving", "logistics");
  const network: PlannerNetwork = { request: structuredClone(yazhen.request) as BlueprintPlannerRequest,
    nodes: [a, b], slotLinks: [], initialSlots: [], preferredGasCount: 0 };
  const poses = [{ x: 2, y: 2, rotation: 0 as const }, { x: -1, y: 2, rotation: 0 as const }];
  const before = JSON.stringify({ network, poses });
  let evaluations = 0;
  const result = constructCompactLayout(registry, network, [], { width: 4, height: 4 }, 0,
    () => { evaluations++; return true; }, { poses, movable: [1] });
  expect(result).not.toBeNull();
  expect(result![0]).toEqual(poses[0]);
  expect(result![1]!.x).toBeGreaterThanOrEqual(0);
  expect(result![1]).not.toEqual(result![0]);
  expect(evaluations).toBeGreaterThan(0);
  expect(constructCompactLayout(registry, network, [], { width: 4, height: 4 }, 0,
    () => false, { poses, movable: [1] })).toBeNull();
  expect(JSON.stringify({ network, poses })).toBe(before);
});

it("无法容纳设备的重建仍记入共享提案数，不绕过批次和全局预算", async () => {
  const registry = createRegistryContract();
  const a = createPlainNode(registry, "storager_1", "moving", "auxiliary");
  const network: PlannerNetwork = { request: structuredClone(yazhen.request) as BlueprintPlannerRequest,
    nodes: [a], slotLinks: [], initialSlots: [], preferredGasCount: 0 };
  const statistics: PlannerSearchStatistics = { seed: 0, strategy: "compact", maximumArea: 1, experiments: ["partial-rebuild"],
    evaluationLimit: 1600, evaluations: 0, acceptedMoves: 0, routingAttempts: 0,
    initialWireLength: 0, finalWireLength: 0, outline: { width: 1, height: 1 } };
  const search = new CompactLayoutSearch(registry, network, [], statistics);
  expect(await search.advance(1500, () => {})).toBe(false);
  expect(statistics.evaluations).toBe(1500);
  expect(await search.advance(100, () => {})).toBe(false);
  expect(statistics.rebuildAttempts).toBe(1);
  expect(statistics.evaluations).toBe(1600);
  expect(await search.advance(100, () => {})).toBe(false);
  expect(statistics.evaluations).toBe(1600);
});

it("重建跨小批次继续同一个枚举，不重复扣账，也不提交未完成位置", async () => {
  const registry = createRegistryContract();
// AI-REMOVED 2026-10-05:
// Reason: external 不再代表永久固定设备，旧场景把储存箱误作外接入口。
// Trigger: 用户确认外部存取线、最多连续面数及外接传送带互斥规则。
// Evidence: 旧实现固定设施撑大包围盒并进入面积与导出。
// Replacement: 下方 5 个本体、4 格的最小重建场景。
// Risk: 旧搜索种子失效，按算法版本重置。
// Human Review: Required
// Original code:
//   const fixed = { ...createPlainNode(registry, "storager_1", "fixed", "auxiliary"), external: true };
//   const moving = createPlainNode(registry, "belt_straight_1x1", "moving", "logistics");
//   const network: PlannerNetwork = { request: structuredClone(yazhen.request) as BlueprintPlannerRequest,
//     nodes: [fixed, moving], slotLinks: [], initialSlots: [], preferredGasCount: 0 };
  // 2026-10-05：external 现为可换边的外接入口；用五个独立本体争用四格，保留几何无解及跨批枚举条件。
  const nodes = Array.from({ length: 5 }, (_, index) => createPlainNode(registry, "belt_straight_1x1", `moving-${index}`, "logistics"));
  const network: PlannerNetwork = { request: structuredClone(yazhen.request) as BlueprintPlannerRequest,
    nodes, slotLinks: [], initialSlots: [], preferredGasCount: 0 };
  const before = JSON.stringify(network);
  const statistics: PlannerSearchStatistics = { seed: 0, strategy: "compact", maximumArea: 4, experiments: ["partial-rebuild"],
    evaluationLimit: 1510, evaluations: 0, acceptedMoves: 0, routingAttempts: 0,
    initialWireLength: 0, finalWireLength: 0, outline: { width: 2, height: 2 } };
  const search = new CompactLayoutSearch(registry, network, [], statistics);
  await search.advance(1500, () => {});
  expect(await search.advance(1, () => {})).toBe(false);
  expect(statistics.rebuildAttempts).toBe(1);
  expect(statistics.rebuildEvaluations).toBe(1);
  expect(await search.advance(1, () => {})).toBe(false);
  expect(statistics.rebuildAttempts).toBe(1);
  expect(statistics.rebuildEvaluations).toBe(2);
  expect(statistics.evaluations).toBe(1502);
  expect(JSON.stringify(network)).toBe(before);
});

it("显式关闭实验不会消耗局部重建预算", async () => {
  const registry = createRegistryContract();
  const node = createPlainNode(registry, "storager_1", "moving", "auxiliary");
  const network: PlannerNetwork = { request: structuredClone(yazhen.request) as BlueprintPlannerRequest,
    nodes: [node], slotLinks: [], initialSlots: [], preferredGasCount: 0 };
  const statistics: PlannerSearchStatistics = { seed: 0, strategy: "compact", maximumArea: 1, experiments: [],
    evaluationLimit: 1600, evaluations: 0, acceptedMoves: 0, routingAttempts: 0,
    initialWireLength: 0, finalWireLength: 0, outline: { width: 1, height: 1 } };
  const search = new CompactLayoutSearch(registry, network, [], statistics);
  expect(await search.advance(1600, () => {})).toBe(false);
  expect(statistics.evaluations).toBe(1600);
  expect(statistics.rebuildAttempts ?? 0).toBe(0);
  expect(statistics.rebuildEvaluations ?? 0).toBe(0);
});
