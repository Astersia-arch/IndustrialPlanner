// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { PlannerCandidateError } from "@/blueprint-planner/model";
import { PlannerRouter } from "@/blueprint-planner/router";
import type { PlannerPort } from "@/blueprint-planner/geometry";
import { plannerOutlineCap, clampPlannerOutline } from "@/blueprint-planner/search-outline";
import yazhen from "./fixtures/yazhen-syringe.json";

const registry = createRegistryContract();
const boundary = { minimumX: 0, minimumY: 0, maximumX: 7, maximumY: 8, escapeLength: 0 };
const source: PlannerPort = { entityId: "source", groupIndex: 0, portIndex: 0, direction: "output", kind: "belt",
  cell: { x: 0, y: 0 }, outside: { x: 1, y: 0 }, edge: "EAST" };
const target: PlannerPort = { ...source, entityId: "target", direction: "input", cell: { x: 7, y: 1 }, outside: { x: 6, y: 1 }, edge: "WEST" };
// 第二条线路先占用「更短路径」的中段，迫使第一条线路先绕远，压缩阶段清格后才有机会改短。
const blockerSource: PlannerPort = { ...source, entityId: "blocker", cell: { x: 3, y: 3 }, outside: { x: 3, y: 2 }, edge: "SOUTH" };
const blockerTarget: PlannerPort = { ...target, entityId: "blocker-end", cell: { x: 4, y: 3 }, outside: { x: 4, y: 2 }, edge: "SOUTH" };

it("压缩后重排线路更短，且线路数量与实体占用保持一致", async () => {
  const router = new PlannerRouter(registry, [], [source, target, blockerSource, blockerTarget], boundary);
  await router.connect(blockerSource, blockerTarget, () => {});
  await router.connect(source, target, () => {});
  const before = router.routes.map(route => route.cells.length);
  const improved = await router.compactRoutes(() => {}, message => { throw new PlannerCandidateError(message); });
  const after = router.routes.map(route => route.cells.length);
  expect(router.routes).toHaveLength(before.length);
  expect(after.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(before.reduce((sum, value) => sum + value, 0));
  expect(improved).toBeGreaterThanOrEqual(0);
  // 压缩后每条线路仍可被 reuse 复核，说明网格状态与线路记录一致。
  for (const route of router.routes) {
    const from = [source, target, blockerSource, blockerTarget].find(port => `${port.entityId}/${port.groupIndex}/${port.portIndex}` === route.sourcePort)!;
    const to = [source, target, blockerSource, blockerTarget].find(port => `${port.entityId}/${port.groupIndex}/${port.portIndex}` === route.targetPort)!;
    expect(new PlannerRouter(registry, [], [from, to], boundary).reuse(from, to, route.cells, route.minimumCells)).toBe(true);
  }
});

it("压缩未变短时完整回滚：线路记录、占用索引与实体都不丢", async () => {
  // 订正 2026-10-06（评审 P1）：原用例名声称覆盖回滚，但它依赖的几何被"没有可压缩空间"的
  // 短路条件挡在压缩分支之外（原注释也承认这点），因此从未真正走到回滚。
  // 现在用一排设备当实体墙：穿越线路被迫绕远（超过曼哈顿+4 才进入压缩分支），
  // 而墙不在该线路的格子集合里、清格不会移除它，所以重排后长度相同 => 走"未变短"回滚分支。
  const wall = Array.from({ length: 6 }, (_, index) => ({ id: `wall-${index}`, definitionId: "storager_1",
    position: { x: 6, y: 1 + index }, rotation: 0, config: {}, tags: [] }));
  const boundaryWithWall = { minimumX: 0, minimumY: 0, maximumX: 11, maximumY: 8, escapeLength: 0 };
  const from: PlannerPort = { ...source, entityId: "cross-from", cell: { x: 0, y: 3 }, outside: { x: 1, y: 3 }, edge: "EAST" };
  const to: PlannerPort = { ...target, entityId: "cross-to", cell: { x: 11, y: 3 }, outside: { x: 10, y: 3 }, edge: "WEST" };
  const router = new PlannerRouter(registry, wall, [from, to], boundaryWithWall);
  await router.connect(from, to, () => {});
  const before = router.routes.map(route => ({ cells: route.cells.map(cell => ({ ...cell })), entities: router.entities.length }));
  const detour = before[0]!.cells;
  const straight = Math.abs(from.outside.x - to.outside.x) + Math.abs(from.outside.y - to.outside.y);
  // 前置条件：这条线路确实是绕行（否则压缩会短路，用例退化为无效）。
  expect(detour.length).toBeGreaterThan(straight + 4);
  const improved = await router.compactRoutes(() => {}, message => { throw new PlannerCandidateError(message); });
  expect(improved).toBe(0);
  // 线路记录必须原样保留（修复前这里会因 removeChain 摘除后未还原而丢失）。
  expect(router.routes.map(route => route.cells)).toEqual(before.map(entry => entry.cells));
  // 压缩失败不得留下新增实体（修复前 connectCpu 写入的实体不会被回收）。
  expect(router.entities).toHaveLength(before[0]!.entities);
  // 回滚后占用索引与网格必须一致：同一线路在新 Router 里仍可被 reuse 复核通过。
  expect(new PlannerRouter(registry, wall, [from, to], boundaryWithWall).reuse(from, to, router.routes[0]!.cells,
    router.routes[0]!.minimumCells)).toBe(true);
});

// 预算取消在压缩内部的传播由 connectCpu 的 checkBudget 触发；本用例的短路不会进入压缩分支，
// 故不在此断言，避免依赖网格几何巧合。该分支在 candidate.test.ts 的真实任务预算路径上覆盖。

it("区域上限按基地可放置范围解析，未知基地不下发上限", () => {
  const request = structuredClone(yazhen.request) as BlueprintPlannerRequest;
  const known = { ...request, plan: { ...request.plan, sourceBaseId: "wuling_protocol_core" } };
  expect(plannerOutlineCap(registry, known)).toEqual({ width: 80, height: 80 });
  const unknown = { ...request, plan: { ...request.plan, sourceBaseId: "no-such-base" } };
  expect(plannerOutlineCap(registry, unknown)).toBeUndefined();
});

it("上限不足以容纳最小边界时以最小边界为准，避免产出无法布通的盒子", () => {
  expect(clampPlannerOutline({ width: 40, height: 40 }, { width: 30, height: 3 }, { width: 20, height: 20 }))
    .toEqual({ width: 30, height: 20 });
  expect(clampPlannerOutline({ width: 10, height: 10 }, { width: 3, height: 3 }, { width: 8, height: 12 }))
    .toEqual({ width: 8, height: 10 });
  expect(clampPlannerOutline({ width: 10, height: 10 }, { width: 3, height: 3 })).toEqual({ width: 10, height: 10 });
});
