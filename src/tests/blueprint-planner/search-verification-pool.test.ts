// @vitest-environment node
//
// 2026-10-07：用户要求"完全释放 CPU 性能极限"后新增的回归测试。
// 旧实现在两处让整机空转：验证队列一满就用全局闸门停掉整轮搜索；验证通道数固定为
// "实测容量的一半、且不超过 8"，搜索等验证时空出来的核完全没人用。
// 这两条都不是靠读代码能发现的，而是 28 核机器上的实测现象（占用 94% → 4%，吞吐归零 20 秒以上）。
//
// 订正 2026-10-07（合并上游 0cca0f89）：上面的"两处整机空转"由本地提交修复，但上游本次提交
// 重写了验证调度（共享额度 + 独立验证控制器），本地那套分配规则已整体作废，因此本文件原有的
// 两条用例不再成立（原文见文件末的 AI-REMOVED 记录）。合并后本文件只保留一条与本地保留项
// （PlannerHostOptions.verificationConcurrency）直接相关的用例。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBlueprintDocument } from "@/domain/document/blueprint-document";
import type { WorkspaceContract } from "@/domain/document/workspace-contract";
import type { SimulationBlueprintRunReport } from "@/domain/simulation";
import { createRegistryContract } from "@/registry";
import type { PlannerCandidate } from "@/blueprint-planner/candidate";
import { createBlueprintPlannerHost } from "@/blueprint-planner/blueprint-planner-host";
import { readPlanningInput } from "@/scripts/eda/planning-input";
import plant from "./fixtures/plant-preload.json";

const workerBuild = vi.hoisted(() => vi.fn());
const listBlueprintDirectory = vi.hoisted(() => vi.fn());
const createBlueprintFolder = vi.hoisted(() => vi.fn());
const saveBlueprintDocument = vi.hoisted(() => vi.fn());

vi.mock("@/blueprint-planner/worker-client", () => ({
  PlannerWorkerClient: class {
    build = workerBuild;
    dispose(): void {}
  },
}));

vi.mock("@/blueprint-planner/verification", async importOriginal => ({
  ...await importOriginal<typeof import("@/blueprint-planner/verification")>(),
  meetsOperatingLimits: () => true,
  meetsProductionTargets: () => true,
}));

vi.mock("@/shared/storage/blueprint-storage", () => ({
  listBlueprintDirectory,
  createBlueprintFolder,
  saveBlueprintDocument,
}));

function candidate(area: number): PlannerCandidate {
  return {
    supplyAudit: { operatingLimits: [], splitterCount: 0, bufferedAdmissions: 0 },
    search: {
      seed: 0, evaluationLimit: 1_000, outline: { width: 10, height: area / 10 }, evaluations: 1,
      acceptedMoves: 0, routingAttempts: 0, initialWireLength: 0, finalWireLength: 0,
    },
    execution: {
      blueprint: createBlueprintDocument({
        name: `候选 ${area}`, baseId: "wuling_protocol_core", initialGridPoint: { x: 0, y: 0 },
        entities: {}, entityOrder: [], slotLinks: [],
      }),
      scene: { externalEntities: [], externalSlotLinks: [], initialSlots: [], powerMode: "infinite" },
      probes: [], warmupSeconds: 0, observationSeconds: 60, inventorySampleCount: 1,
      maxWallTimeMs: 1_000, activeActivityIds: [],
    },
    metrics: { width: 10, height: area / 10, area, entityCount: 0, productionDeviceCount: 0,
      gasDiffuserCount: 0, additionalGasDiffuserCount: 0, score: area },
    connections: [],
  };
}

const report: SimulationBlueprintRunReport = {
  status: "completed", engineKind: "dense-v2", simulationSeconds: 60, observationSeconds: 60, elapsedMs: 1,
  probes: [], inventorySamples: [], deviceStatuses: [], diagnostics: [],
};

/** 验证很慢但会结算：用于观察"搜索 + 验证"的并发之和。 */
function sluggishVerification(delayMs: number, onStart: () => void, onSettle: () => void) {
  return vi.fn((_request: unknown, signal?: AbortSignal) => {
    onStart();
    return new Promise<SimulationBlueprintRunReport>(resolve => {
      const finish = () => { clearTimeout(timer); onSettle(); resolve(report); };
      const timer = setTimeout(finish, delayMs);
      signal?.addEventListener("abort", finish, { once: true });
    });
  });
}

function workspaceWith(runBlueprint: unknown): WorkspaceContract {
  return {
    registry: createRegistryContract(), simulation: { actions: { stop: vi.fn(), runBlueprint } },
    audio: null, blueprintPlanner: null, state: {}, app: null, editor: null, render: null, sync: null,
  } as unknown as WorkspaceContract;
}

describe("EDA 搜索与验证的算力分配", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBlueprintDirectory.mockResolvedValue({ folders: [{ folderId: "auto", name: "自动规划" }] });
    createBlueprintFolder.mockResolvedValue({ folderId: "auto", name: "自动规划" });
    saveBlueprintDocument.mockResolvedValue({});
  });

  it("搜索与验证共用同一个并发上限，且 verificationConcurrency 限住验证侧", async () => {
    // 上限 6、验证侧显式限 2：搜索 + 验证的在途数量之和不得超过共享上限，
    // 验证并发不得超过显式给它的 2（无头入口按实测把该值钉成 1，用来避免在调用线程里
    // 跑进程内仿真而拖慢派发）。
    const maximum = 6, verificationCap = 2;
    let concurrentVerifications = 0, inFlightSearch = 0, maximumSum = 0, peakVerifications = 0;
    const record = () => {
      maximumSum = Math.max(maximumSum, concurrentVerifications + inFlightSearch);
      peakVerifications = Math.max(peakVerifications, concurrentVerifications);
    };
    const runBlueprint = sluggishVerification(15, () => { concurrentVerifications++; record(); },
      () => { concurrentVerifications--; });
    workerBuild.mockImplementation(async () => {
      inFlightSearch++;
      record();
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        return candidate(100);
      } finally { inFlightSearch--; record(); }
    });
    const workspace = workspaceWith(runBlueprint);
    const host = createBlueprintPlannerHost(workspace, { storage: null, verificationConcurrency: verificationCap });
    const base = readPlanningInput(workspace.registry, plant);
    const request = { ...base, options: { ...base.options, concurrency: maximum, evaluationsPerRound: 500_000 } };
    try {
      host.actions.start(request);
      await vi.waitFor(() => expect(runBlueprint.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
      expect(peakVerifications).toBeLessThanOrEqual(verificationCap);
      expect(maximumSum).toBeLessThanOrEqual(maximum + 1);
    } finally {
      host.dispose();
    }
  });
});

// AI-REMOVED 2026-10-07（合并上游 0cca0f89）:
// Reason: 下面两条用例断言的是本地被替换掉的验证调度——"验证永不结算时搜索仍继续领活"
//         （本地取消了验证队列的全局闸门）与"验证吃掉搜索未占用的全部算力"。
//         上游改用共享额度 + 独立验证控制器后，claim 的高水位是 max(2, maximum)，
//         验证并发也不再由"搜索未占用"推导，两条断言都不再成立。
// Trigger: 用户确认并发与验证调度以官方结构为准，不把本地分配规则重做进上游结构。
// Evidence: 合并后本机运行这两条用例失败（旧实现阈值 max(2, min(target, 并行度×2)) 已被
//           max(2, maximum) 取代）；上游新增 cpu-scheduling.test.ts 覆盖共享上限语义。
// Replacement: 上方"搜索与验证共用同一个并发上限"用例 + src/tests/blueprint-planner/cpu-scheduling.test.ts。
// Risk: Medium —— 本地曾以 28 核实测为依据取消验证队列的全局闸门，合并后该行为不再保留，
//       待高频交互与占用率复测；若再次出现搜索整轮空转，需以上游结构重新评估背压策略。
// Human Review: Required
//
// Original code:
// it("验证长期不返回时，搜索仍然继续领活，不会整轮停摆", async () => {
//   // 32 个虚拟分片、4 路搜索：验证一直不结算，旧实现会在待验证数达到
//   // max(2, min(target, 验证并行度×2)) 后让 claim() 返回 null，搜索通道全部空转。
//   let started = 0;
//   const runBlueprint = slowVerification(() => { started++; }, () => undefined);
//   workerBuild.mockImplementation(() => Promise.resolve(candidate(100)));
//   const workspace = workspaceWith(runBlueprint);
//   const host = createBlueprintPlannerHost(workspace, { storage: null });
//   const base = readPlanningInput(workspace.registry, plant);
//   const request = { ...base, options: { ...base.options, concurrency: 4, evaluationsPerRound: 500_000 } };
//   try {
//     host.actions.start(request);
//     // 新实现会一直领活到所有分片都在验证：32 个分片各挂一个候选。
//     await vi.waitFor(() => expect(runBlueprint.mock.calls.length).toBeGreaterThanOrEqual(24), { timeout: 10_000 });
//     expect(workerBuild.mock.calls.length).toBeGreaterThanOrEqual(24);
//     expect(started).toBeGreaterThanOrEqual(24);
//   } finally {
//     host.dispose();
//   }
// });
//
// it("搜索与验证共用实测容量：两者并发之和不超过上限", async () => {
//   // 上限 6、搜索 4 路：验证最多只能吃下剩下来的 2 路，而不是固定 6 路
//   // （旧实现固定 6 路，搜索 4 + 验证 6 = 10 路抢 6 路的机器，主线程被挤到卡死）。
//   const ceiling = 6;
//   ...（略：断言 peakVerifications >= 2 且 maximumSum <= ceiling + 1）
// });
