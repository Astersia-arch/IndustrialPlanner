// @vitest-environment node
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { calibratePlannerCapacity, planVerificationParallelism } from "@/blueprint-planner/capacity-calibration";

const request = { plan: {}, options: {} } as unknown as BlueprintPlannerRequest;
const confirm = async () => true;

it("全部档位都没有有效吞吐时拒绝本次标定，不再保存无意义的上限", async () => {
  // 订正 2026-10-06（评审 P2）：原实现把全 0 曲线读成"2 档增益仅 1.00×"，
  // 照样落盘 concurrentWorkers = 1；而该值已成为运行时并发起点，等于把整轮规划钉在单通道。
  await expect(calibratePlannerCapacity(async options => ({ workers: options.workers, windowMs: 4_000,
    evaluations: 0, lagMs: 0 }), { request, engineKind: "dense-v2", confirm, maxLevels: 3 }))
    .rejects.toThrow(/没有取得任何有效吞吐样本/);
});

it("档位数受 maxLevels 截断，平台点落在实测档位并给出验证并行度上限", async () => {
  const report = await calibratePlannerCapacity(async options => ({ workers: options.workers, windowMs: 4_000,
    evaluations: options.workers * 1_000, lagMs: 0 }), { request, engineKind: "dense-v2", confirm, maxLevels: 3 });
  // maxLevels 此前只用于估算确认框耗时，从未限制档位；现在必须真的截断。
  expect(report.points.map(point => point.workers)).toEqual([1, 2, 3]);
  expect(report.concurrentWorkers).toBe(3);
  // 订正 2026-10-07：验证并行度的上限就是实测容量本身。旧实现固定为"容量的一半、且不超过 8"，
  // 实测证明它会让搜索等验证时空出来的核无人使用（28 核机器占用掉到 4%~8%）。
  expect(report.verificationWorkers).toBe(3);
});

it("验证并行度按搜索占用动态分配：搜索占满时留 1 路，搜索空闲时吃满上限", () => {
  // 搜索与验证共用同一台机器的算力：总和不超过实测容量，谁有活谁用。
  expect(planVerificationParallelism(8, 8)).toBe(1);
  expect(planVerificationParallelism(8, 5)).toBe(3);
  expect(planVerificationParallelism(8, 0)).toBe(8);
  // 搜索超过上限（缩容尚未生效）时仍必须保留 1 路验证，否则候选永远解锁不了。
  expect(planVerificationParallelism(8, 30)).toBe(1);
  expect(planVerificationParallelism(1, 1)).toBe(1);
  expect(planVerificationParallelism(0, 0)).toBe(1);
});
