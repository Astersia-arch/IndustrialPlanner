// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";

const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn() }));
vi.mock("@/blueprint-planner/worker-client", () => ({
  PlannerWorkerClient: class {
    build = buildMock;
    dispose = () => Promise.resolve();
  },
}));

const { probeBrowserPlannerCapacity } = await import("@/blueprint-planner/browser-capacity-probe");

it("超时或失败的通道，其已上报的评估数必须计入吞吐", async () => {
  // 订正 2026-10-06（评审 P2）：原实现只累加成功返回的会话。
  // 协议复现里 Worker 已上报 2000 次评估、随后超时，探针记录却是 0。
  buildMock.mockImplementation(async (_request: unknown, _variant: unknown, _budget: unknown, _evaluations: unknown,
    _signal: unknown, update: (phase: string, message: string, count: number) => void) => {
    update("layout", "搜索中", 2_000);
    throw new Error("超时");
  });
  const probe = await probeBrowserPlannerCapacity({ request: { plan: {}, options: {} } as unknown as BlueprintPlannerRequest,
    engineKind: "dense-v2", workers: 2, windowMs: 4_000, evaluationsPerWindow: 20_000 });
  expect(probe.evaluations).toBe(4_000);
});

it("成功返回的通道取返回计数与上报计数的较大者，不重复计算", async () => {
  buildMock.mockImplementation(async (_request: unknown, _variant: unknown, _budget: unknown, _evaluations: unknown,
    _signal: unknown, update: (phase: string, message: string, count: number) => void) => {
    update("layout", "搜索中", 1_500);
    update("layout", "搜索中", 3_000);
    return { search: { evaluations: 2_400 } };
  });
  const probe = await probeBrowserPlannerCapacity({ request: { plan: {}, options: {} } as unknown as BlueprintPlannerRequest,
    engineKind: "dense-v2", workers: 1, windowMs: 4_000, evaluationsPerWindow: 20_000 });
  expect(probe.evaluations).toBe(3_000);
});
