// @vitest-environment node
// 订正 2026-10-07（PR #34 评审：标定缺少完整的独占和取消机制）：
// 原实现只有「标定入口检查有没有活动任务」这一个方向，标定自己不登记忙碌状态，
// 于是标定期间照常可以启动计算/导入/识别蓝图，测出的曲线是混合结果；
// Host 销毁也不会取消独立探针，留下继续抢核的计算。两条语义在此固定。
import { expect, it } from "vitest";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { createRegistryContract } from "@/registry";
import { createWorkspaceState } from "@/domain/document/workspace-state";
import type { WorkspaceContract } from "@/domain/document/workspace-contract";
import { createBlueprintPlannerHost } from "@/blueprint-planner/blueprint-planner-host";
import type { PlannerCapacityProbeOptions } from "@/blueprint-planner/capacity-calibration";
import yazhen from "./fixtures/yazhen-syringe.json";

function workspace(): WorkspaceContract {
  return { state: createWorkspaceState(), registry: createRegistryContract(),
    app: null, audio: null, editor: null, render: null, simulation: null, sync: null, blueprintPlanner: null };
}

it("标定期间独占算力：启动计算、导入与识别蓝图都被拒绝", async () => {
  let observed: AbortSignal | undefined;
  let settle!: () => void;
  const finished = new Promise<void>(resolve => { settle = resolve; });
  const host = createBlueprintPlannerHost(workspace(), {
    storage: null,
    // 探针挂住直到信号取消，从而把 Host 稳定停在「标定中」。
    capacityProbe: (probeOptions: PlannerCapacityProbeOptions) => {
      observed = probeOptions.signal;
      return new Promise((_, reject) => probeOptions.signal?.addEventListener("abort",
        () => { settle(); reject(new DOMException("取消标定", "AbortError")); }));
    },
  });
  const request = structuredClone(yazhen.request) as BlueprintPlannerRequest;
  const calibration = host.actions.calibrateCapacity(request, async () => true, () => undefined);
  calibration.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    expect(() => host.actions.start(structuredClone(request) as BlueprintPlannerRequest))
      .toThrow("算力基准测试进行中");
    await expect(host.actions.importTask(host.queries.exportDraft(request))).rejects.toThrow("算力基准测试进行中");
    expect(host.queries.listTasks()).toHaveLength(0);
  } finally {
    host.dispose();
    await finished;
  }
  // 销毁 Host 必须把取消信号送达独立探针，否则探针会继续抢核。
  expect(observed?.aborted).toBe(true);
  expect(host.queries.listTasks()).toHaveLength(0);
}, 30_000);
