import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import type { PlannerCapacityProbe, PlannerCapacityProbeOptions } from "@/blueprint-planner/capacity-calibration";
import { LoopLagSampler } from "./loop-lag-sampler";
import { PlannerWorkerClient } from "./worker-client";

/**
 * 单通道提案预算上限。必须显著高于窗口内可能达到的量：
 * 若预算先于时间窗耗尽，实际测量时长会随档位漂移，吞吐就不可比了。
 */
const PROBE_EVALUATIONS_PER_WORKER = 5_000_000;

/**
 * 浏览器侧算力探针：并行启动 N 个真实布局 Worker，在固定时间窗内统计累计提案数。
 * 与 Node 侧探针（scripts/eda/capacity-probe.ts）保持同一测量口径：
 * 只测布局生成，不含仿真验证——验证在不同机器上会因内存争用产生假平台。
 */
export async function probeBrowserPlannerCapacity(options: PlannerCapacityProbeOptions): Promise<PlannerCapacityProbe> {
  const { request, engineKind, workers, windowMs } = options;
  // 与 Host 派发通道一致地决定 GPU 通道：标定测的必须是任务真正会用的算力组合。
  const allowGpu = request.options.concurrency === "auto";
  const clients = Array.from({ length: workers }, () => new PlannerWorkerClient(allowGpu));
  // 订正 2026-10-06（评审 P1）：Worker 通过进度回调持续上报已完成的评估数。
  // 原实现只累加"成功返回"的会话，超时或失败前已完成的评估被整份丢弃
  // （协议复现：Worker 已上报 2000 次，探针记 0），高并发档位因此被系统性低估，
  // 膝盖点会偏低。这里按通道记下最后一次上报值，作为该通道已完成工作的下界。
  const reported = new Array<number>(workers).fill(0);
  const sampler = new LoopLagSampler();
  const startedAt = performance.now();
  try {
    const outcomes = await Promise.allSettled(clients.map((client, index) => client.build(request as BlueprintPlannerRequest, 0,
      windowMs, PROBE_EVALUATIONS_PER_WORKER, options.signal ?? new AbortController().signal,
      (_phase, _message, count) => { if (Number.isSafeInteger(count) && count > reported[index]!) reported[index] = count; })));
    const evaluations = outcomes.reduce((sum, outcome, index) => sum + Math.max(outcome.status === "fulfilled"
      ? outcome.value.search.evaluations : 0, reported[index]!), 0);
    // 探针必须暴露失败原因：静默吞掉会让整条吞吐曲线变成 0 而看不出问题。
    const failures = outcomes.flatMap(outcome => outcome.status === "rejected"
      ? [outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)] : []);
    if (failures.length) console.error(`[容量探针] ${workers} 通道有 ${failures.length} 个会话失败: ${failures[0]}`);
    return { workers, windowMs: performance.now() - startedAt, evaluations, lagMs: sampler.stop() };
  } finally {
    sampler.stop();
    await Promise.allSettled(clients.map(client => client.dispose()));
    void engineKind;
  }
}
