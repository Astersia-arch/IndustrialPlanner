// @vitest-environment node
import { expect, it } from "vitest";
import { PlannerRoutingGrid, ROUTE_BLOCKED, ROUTE_OCCUPIED, ROUTE_OPEN, ROUTE_RESERVED } from "@/blueprint-planner/routing-grid";
import { PlannerRoutingPerformance } from "@/blueprint-planner/routing-backend";
import { PlannerGpuRouting } from "@/blueprint-planner/gpu-routing";
import { PlannerRouter } from "@/blueprint-planner/router";
import { createRegistryContract } from "@/registry";
import type { PlannerPort } from "@/blueprint-planner/geometry";

it("数值镜像保持障碍、预留和交叉的增量变更，并隔离不同布局", () => {
  const grid = new PlannerRoutingGrid(), cell = grid.cell(-1, 2);
  grid.block(cell, 2);
  const bounds = { x: -2, y: 1, width: 4, height: 3 }, snapshot = grid.dense(bounds), offset = 10;
  expect(snapshot.values[offset]! & ROUTE_BLOCKED).not.toBe(0);
  expect(snapshot.values[offset + 1]! & ROUTE_BLOCKED).toBe(0);
  snapshot.firstDirty = snapshot.values.length; snapshot.lastDirty = 0;
  grid.reserve(cell, 1); grid.updateRoute(cell, 0, 10, (1 << 5) | (1 << 15));
  expect(grid.dense(bounds)).toBe(snapshot);
  expect([snapshot.firstDirty, snapshot.lastDirty]).toEqual([offset, offset + 2]);
  expect(snapshot.values[offset]! & ROUTE_OCCUPIED).not.toBe(0);
  expect(snapshot.values[offset + 1]! & ROUTE_RESERVED).not.toBe(0);
  expect(snapshot.values[offset]! & 0xffff).toBe((1 << 5) | (1 << 15));
  const other = new PlannerRoutingGrid().dense(bounds);
  expect(other.values[offset]).toBe(ROUTE_OPEN);
  expect(grid.dense({ ...bounds, width: 5 }).values[12]! & ROUTE_OCCUPIED).not.toBe(0);
});

it("GPU 分派以包含数据往返的同题耗时为依据，无收益时冷却后重试，大图独立探测", () => {
  const policy = new PlannerRoutingPerformance();
  for (let i = 0; i < 3; i++) {
    expect(policy.choose(100, i)).toBe("compare");
    policy.record(100, 1, 4, i);
  }
  expect(policy.choose(100, 10)).toBe("cpu");
  expect(policy.choose(100, 30_003)).toBe("compare");
  expect(policy.choose(1000, 10)).toBe("compare");
  for (let i = 0; i < 3; i++) policy.record(1000, 20, 2, i);
  expect(policy.choose(1000, 10)).toBe("gpu");
  for (let i = 0; i < 31; i++) policy.choose(1000, 10);
  expect(policy.choose(100, 20)).toBe("cpu");
});

it("没有 WebGPU 时执行完整 CPU 布线；取消不会因回退而被吞掉", async () => {
  const source: PlannerPort = { entityId: "a", groupIndex: 0, portIndex: 0, direction: "output", kind: "belt",
    cell: { x: 0, y: 2 }, outside: { x: 1, y: 2 }, edge: "EAST" };
  const target: PlannerPort = { ...source, entityId: "b", direction: "input", cell: { x: 7, y: 2 }, outside: { x: 6, y: 2 }, edge: "WEST" };
  const backend = new PlannerGpuRouting();
  const router = new PlannerRouter(createRegistryContract(), [], [source, target], {
    minimumX: 0, minimumY: 0, maximumX: 7, maximumY: 5, escapeLength: 0,
  }, backend);
  await expect(router.connect(source, target, () => { throw new DOMException("暂停", "AbortError"); })).rejects.toMatchObject({ name: "AbortError" });
  expect(router.routes).toHaveLength(0);
  expect(await router.connect(source, target, () => {})).toBe(6);
  expect(router.routes[0]!.cells).toHaveLength(6);
  expect(backend.metrics.gpuAttempts).toBe(0);
  expect(backend.metrics.fallbackReason).toBeDefined();
});

it("GPU 在对照模式下连续空手而归后进入冷却，不再每次都空跑一遍", () => {
  // 订正 2026-10-06（评审 P2）：失败原本完全不留样本，样本数永远到不了 3，
  // choose() 因此永远返回 compare，每次请求都先跑 GPU 再回退 CPU。
  const policy = new PlannerRoutingPerformance();
  expect(policy.choose(1024, 0)).toBe("compare");
  for (let attempt = 0; attempt < 3; attempt++) policy.recordGpuFailure(1024, 0);
  expect(policy.choose(1024, 1_000)).toBe("cpu");
  // 冷却到期后再给一次对照机会，机器或驱动变化仍能被发现。
  expect(policy.choose(1024, 30_000)).toBe("compare");
  // 一旦积累了足够的成功对照样本，失败计数清零并回到正常的成本比较分支（GPU 更快 => 用 GPU）。
  for (let sample = 0; sample < 3; sample++) policy.record(1024, 20, 2, 30_000);
  expect(policy.choose(1024, 30_001)).toBe("gpu");
});
