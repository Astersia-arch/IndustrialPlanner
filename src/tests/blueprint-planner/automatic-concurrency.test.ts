import { expect, it } from "vitest";
import { PlannerAutomaticConcurrency, plannerConcurrencyLimit } from "@/blueprint-planner/automatic-concurrency";

it("容量提示保留 CPU 余量，缺失提示时不会盲目启满 32 Worker", () => {
  expect(plannerConcurrencyLimit({})).toBe(1);
  expect(plannerConcurrencyLimit({ hardwareConcurrency: 32 })).toBe(4);
  expect(plannerConcurrencyLimit({ hardwareConcurrency: 32, deviceMemory: 64 })).toBe(24);
  expect(plannerConcurrencyLimit({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(2);
  expect(plannerConcurrencyLimit({ hardwareConcurrency: 1, deviceMemory: 0.5 })).toBe(1);
});

it("增加并发没有吞吐收益时退回，冷却后仍可再次试探", () => {
  const control = new PlannerAutomaticConcurrency(4, 0, 0);
  const sample = (at: number, evaluations: number, activeWorkers: number) => control.observe({ at, evaluations, activeWorkers,
    pendingVerifications: 0, lagMs: 0 });
  expect(sample(1000, 100, 1)).toBe(1);
  expect(sample(4000, 400, 1)).toBe(2);
  expect(sample(8000, 800, 2)).toBe(1);
  expect(sample(12_000, 1200, 1)).toBe(1);
  expect(sample(40_000, 4000, 1)).toBe(2);
});

it("吞吐提升允许增容，验证积压和偶发卡顿不收缩，持续卡顿才退让", () => {
  const control = new PlannerAutomaticConcurrency(3, 0, 0);
  expect(control.observe({ at: 4000, evaluations: 400, activeWorkers: 1, pendingVerifications: 0, lagMs: 0 })).toBe(2);
  expect(control.observe({ at: 8000, evaluations: 1200, activeWorkers: 2, pendingVerifications: 0, lagMs: 0 })).toBe(3);
  expect(control.observe({ at: 12_000, evaluations: 2400, activeWorkers: 3, pendingVerifications: 0, lagMs: 0 })).toBe(3);
  // AI-REMOVED 2026-10-03:
  // Reason: 用户要求修正 Windows 上验证排队和一次卡顿导致长期单 Worker 的错误判断。
  // Trigger: CPU 容量判断与验证背压分离。Evidence: before-desktop-02 的 nominal 压力及冷却记录。
  // Replacement: 下方持续压力、偶发延迟与恢复断言。Risk: Low。Human Review: Required
  // Original code:
  // expect(control.observe({ at: 13_000, evaluations: 2700, activeWorkers: 3, pendingVerifications: 0, lagMs: 200 })).toBe(2);
  // expect(control.observe({ at: 14_000, evaluations: 2900, activeWorkers: 2, pendingVerifications: 2, lagMs: 0 })).toBe(1);
  // expect(control.observe({ at: 18_000, evaluations: 3300, activeWorkers: 1, pendingVerifications: 0, lagMs: 0 })).toBe(1);
  expect(control.observe({ at: 13_000, evaluations: 2700, activeWorkers: 3, pendingVerifications: 0, lagMs: 200 })).toBe(3);
  expect(control.observe({ at: 14_000, evaluations: 2900, activeWorkers: 0, pendingVerifications: 3, lagMs: 0 })).toBe(3);
  for (const at of [15_000, 16_000]) {
    expect(control.observe({ at, evaluations: at / 4, activeWorkers: 3, pendingVerifications: 0, lagMs: 200 })).toBe(3);
  }
  expect(control.observe({ at: 17_000, evaluations: 4500, activeWorkers: 3, pendingVerifications: 0, lagMs: 200 })).toBe(2);
  expect(control.observe({ at: 21_000, evaluations: 5500, activeWorkers: 2, pendingVerifications: 0, lagMs: 0 })).toBe(3);
});

it("没有工作进展或执行通道未用满时不增容，CPU 压力可独立触发收缩", () => {
  const control = new PlannerAutomaticConcurrency(8, 0, 0);
  expect(control.observe({ at: 4000, evaluations: 0, activeWorkers: 1, pendingVerifications: 0, lagMs: 0 })).toBe(1);
  expect(control.observe({ at: 8000, evaluations: 100, activeWorkers: 0, pendingVerifications: 0, lagMs: 0 })).toBe(1);
  expect(control.observe({ at: 12_000, evaluations: 200, activeWorkers: 1, pendingVerifications: 0, lagMs: 0 })).toBe(2);
  expect(control.observe({ at: 13_000, evaluations: 250, activeWorkers: 2, pendingVerifications: 0, lagMs: 0, pressure: "critical" })).toBe(1);
});
