// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { calibratePlannerCapacity, deriveVerificationWorkers } from "@/blueprint-planner/capacity-calibration";

const request = { plan: {}, options: {} } as unknown as BlueprintPlannerRequest;
const confirm = async () => true;

it("全部档位都没有有效吞吐时拒绝本次标定，不再保存无意义的上限", async () => {
  // 订正 2026-10-06（评审 P2）：原实现把全 0 曲线读成"2 档增益仅 1.00×"，
  // 照样落盘 concurrentWorkers = 1；而该值已成为运行时并发起点，等于把整轮规划钉在单通道。
  await expect(calibratePlannerCapacity(async options => ({ workers: options.workers, windowMs: 4_000,
    evaluations: 0, lagMs: 0 }), { request, engineKind: "dense-v2", confirm, maxLevels: 3 }))
    .rejects.toThrow(/没有取得任何有效吞吐样本/);
});

it("档位数受 maxLevels 截断，平台点落在实测档位并派生验证并行度", async () => {
  const report = await calibratePlannerCapacity(async options => ({ workers: options.workers, windowMs: 4_000,
    evaluations: options.workers * 1_000, lagMs: 0 }), { request, engineKind: "dense-v2", confirm, maxLevels: 3 });
  // maxLevels 此前只用于估算确认框耗时，从未限制档位；现在必须真的截断。
  expect(report.points.map(point => point.workers)).toEqual([1, 2, 3]);
  expect(report.concurrentWorkers).toBe(3);
  expect(report.verificationWorkers).toBe(deriveVerificationWorkers(3));
  // 派生的验证并行度：至少 1、至多 8（单通道仿真内存政策上限）。
  expect(deriveVerificationWorkers(1)).toBe(1);
  expect(deriveVerificationWorkers(27)).toBe(8);
  expect(deriveVerificationWorkers(0)).toBe(1);
});
