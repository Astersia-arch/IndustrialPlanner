import {
  type BrowserContext,
  type TestInfo,
  type Page,
} from "playwright/test";

// AI-REMOVED 2026-10-05:
// Reason: 审计同时供 CLI 与原生执行器调用，失败使用原生异常。
// Trigger: 统一审计覆盖。Evidence: CLI 不装载 Playwright test runner。
// Replacement: 下方 Error 与 harness/fixture.ts 的 expect 出口。
// Risk: Low。Human Review: Required
// Original code:
// import { expect } from "playwright/test";
// export { expect };
export type { APIRequestContext, Page } from "playwright/test";

const CANVAS_LOCK_SELECTOR = '[data-sync-initial-sync-stage="canvas"]';
const REPORT_BINDING_NAME = "__reportE2eCanvasLock";
const FLUSH_BINDING_NAME = "__flushE2eCanvasLockAudit";

interface CanvasLockSnapshot {
  readonly occurredAt: string;
  readonly documentUrl: string;
  readonly phase: string | null;
  readonly currentRunReason: string | null;
  readonly initialSyncStage: string | null;
  readonly canvasLocked: boolean | null;
  readonly pendingConflictPhase: string | null;
}

interface CanvasLockObservedEvent {
  readonly kind: "lock-observed";
  readonly snapshot: CanvasLockSnapshot;
}

interface IntervalLockObservedEvent {
  readonly kind: "interval-lock-observed";
  readonly runId: string;
  readonly snapshot: CanvasLockSnapshot;
}

interface IntervalRunCompletedEvent {
  readonly kind: "interval-run-completed";
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly enteredConflict: boolean;
  readonly didDownload: boolean;
  readonly didReportConflict: boolean;
  readonly endedPhase: string | null;
  readonly lockedAfterIdle: boolean;
  readonly adapterResults: readonly {
    readonly adapterId: string | null;
    readonly status: string | null;
  }[];
}

type CanvasLockAuditEvent =
  | CanvasLockObservedEvent
  | IntervalLockObservedEvent
  | IntervalRunCompletedEvent;

interface CanvasLockAuditRecord {
  readonly pageUrl: string;
  readonly event: CanvasLockAuditEvent;
}

interface CanvasLockLifecycleViolation {
  readonly kind:
    | "unexpected-lock"
    | "interval-run-incomplete"
    | "interval-run-no-effective-download"
    | "conflict-run-did-not-return-idle"
    | "canvas-still-locked-after-idle";
  readonly pageUrl: string;
  readonly runId: string | null;
  readonly detail: unknown;
}

/**
 * 所有 E2E 共用的画布锁定审计。
 * 通过 context 级 init script 覆盖默认 page、context.newPage()、刷新与跨页面导航。
 */
// AI-REMOVED 2026-10-05:
// Reason: 默认 context 的自动 fixture 无法覆盖用例自建 context，且 CLI 用例会多开浏览器。
// Trigger: 统一 E2E 资源所有权与审计覆盖。
// Evidence: clipboard-cut-paste 等用例独立 newContext；旧审计只注入框架默认 context。
// Replacement: harness/fixture.ts 在每个受管 context 安装此审计。
// Risk: Low。Human Review: Required
// Original code:
// export const test = base.extend<{ canvasLockAudit: void }>({
//   canvasLockAudit: [async ({ context }, use, testInfo) => {
export async function installCanvasLockAudit(context: BrowserContext, testInfo: TestInfo): Promise<() => Promise<void>> {
    const auditRecords: CanvasLockAuditRecord[] = [];

    await context.exposeBinding(
      REPORT_BINDING_NAME,
      ({ page }: { readonly page: Page }, event: CanvasLockAuditEvent) => {
        auditRecords.push({
          pageUrl: page.url(),
          event,
        });
      },
    );
    await context.addInitScript(
      ({ bindingName, flushBindingName, selector }) => {
        interface BrowserSyncStatus {
          readonly phase?: unknown;
          readonly currentRunReason?: unknown;
          readonly initialSyncStage?: unknown;
          readonly canvasLocked?: unknown;
          readonly lastResults?: readonly {
            readonly adapterId?: unknown;
            readonly status?: unknown;
          }[];
        }

        interface BrowserSyncState {
          readonly status?: BrowserSyncStatus;
          readonly pendingConflict?: {
            readonly phase?: unknown;
          } | null;
        }

        interface ActiveIntervalRun {
          readonly runId: string;
          readonly startedAt: string;
          enteredConflict: boolean;
          completing: boolean;
        }

        const auditWindow = window as unknown as Record<string, unknown>;
        const reportedElements = new WeakSet<Element>();
        const documentAuditId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let intervalRunSequence = 0;
        let activeIntervalRun: ActiveIntervalRun | null = null;
        let reportQueue = Promise.resolve();

        const readSyncState = (): BrowserSyncState | null => {
          const host = window.__industrialPlannerAppHost;
          return (host?.workspace?.sync?.state as BrowserSyncState | undefined) ?? null;
        };
        const toNullableString = (value: unknown): string | null =>
          typeof value === "string" ? value : null;
        const readSnapshot = (): CanvasLockSnapshot => {
          const syncState = readSyncState();
          const status = syncState?.status;
          return {
            occurredAt: new Date().toISOString(),
            documentUrl: window.location.href,
            phase: toNullableString(status?.phase),
            currentRunReason: toNullableString(status?.currentRunReason),
            initialSyncStage: toNullableString(status?.initialSyncStage),
            canvasLocked: typeof status?.canvasLocked === "boolean"
              ? status.canvasLocked
              : null,
            pendingConflictPhase: toNullableString(syncState?.pendingConflict?.phase),
          };
        };
        const reportEvent = (event: CanvasLockAuditEvent): void => {
          reportQueue = reportQueue.then(async () => {
            const reporter = auditWindow[bindingName];
            if (typeof reporter === "function") {
              await (reporter as (payload: CanvasLockAuditEvent) => Promise<void>)(event);
            }
          });
        };
        auditWindow[flushBindingName] = async (): Promise<void> => {
          await reportQueue;
        };

        const reportElement = (element: Element): void => {
          if (reportedElements.has(element)) {
            return;
          }
          reportedElements.add(element);

          const snapshot = readSnapshot();
          if (snapshot.currentRunReason !== "interval") {
            reportEvent({
              kind: "lock-observed",
              snapshot,
            });
            return;
          }

          if (activeIntervalRun === null) {
            intervalRunSequence += 1;
            activeIntervalRun = {
              runId: `${documentAuditId}:interval:${intervalRunSequence}`,
              startedAt: snapshot.occurredAt,
              enteredConflict: snapshot.pendingConflictPhase !== null,
              completing: false,
            };
          }
          reportEvent({
            kind: "interval-lock-observed",
            runId: activeIntervalRun.runId,
            snapshot,
          });
        };
        const inspectNode = (node: Node): void => {
          if (!(node instanceof Element)) {
            return;
          }
          if (node.matches(selector)) {
            reportElement(node);
          }
          for (const element of node.querySelectorAll(selector)) {
            reportElement(element);
          }
        };
        const forgetNode = (node: Node): boolean => {
          if (!(node instanceof Element)) {
            return false;
          }
          let removedReportedElement = false;
          if (node.matches(selector)) {
            removedReportedElement = reportedElements.has(node) || removedReportedElement;
            reportedElements.delete(node);
          }
          for (const element of node.querySelectorAll(selector)) {
            removedReportedElement = reportedElements.has(element) || removedReportedElement;
            reportedElements.delete(element);
          }
          return removedReportedElement;
        };
        const completeIntervalRunIfFinished = (): void => {
          const run = activeIntervalRun;
          if (run === null || run.completing) {
            return;
          }

          const syncState = readSyncState();
          if (syncState?.pendingConflict !== null && syncState?.pendingConflict !== undefined) {
            run.enteredConflict = true;
          }
          const status = syncState?.status;
          if (
            document.querySelector(selector) !== null
            || status?.currentRunReason === "interval"
            || (status?.phase !== "idle" && status?.phase !== "error")
          ) {
            return;
          }

          run.completing = true;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const finalStatus = readSyncState()?.status;
              const adapterResults = Array.isArray(finalStatus?.lastResults)
                ? finalStatus.lastResults.map((result) => ({
                    adapterId: toNullableString(result.adapterId),
                    status: toNullableString(result.status),
                  }))
                : [];
              reportEvent({
                kind: "interval-run-completed",
                runId: run.runId,
                startedAt: run.startedAt,
                completedAt: new Date().toISOString(),
                enteredConflict: run.enteredConflict,
                didDownload: adapterResults.some((result) => result.status === "downloaded"),
                didReportConflict: adapterResults.some((result) => result.status === "conflict"),
                endedPhase: toNullableString(finalStatus?.phase),
                lockedAfterIdle: document.querySelector(selector) !== null,
                adapterResults,
              });
              if (activeIntervalRun === run) {
                activeIntervalRun = null;
              }
            });
          });
        };

        for (const element of document.querySelectorAll(selector)) {
          reportElement(element);
        }
        const observer = new MutationObserver((records) => {
          let removedReportedElement = false;
          for (const record of records) {
            if (record.type === "attributes") {
              if (record.target instanceof Element && record.target.matches(selector)) {
                inspectNode(record.target);
              } else {
                removedReportedElement = forgetNode(record.target)
                  || removedReportedElement;
              }
              continue;
            }
            for (const node of record.addedNodes) {
              inspectNode(node);
            }
            for (const node of record.removedNodes) {
              removedReportedElement = forgetNode(node) || removedReportedElement;
            }
          }
          if (removedReportedElement) {
            completeIntervalRunIfFinished();
          }
        });
        observer.observe(document, {
          attributes: true,
          attributeFilter: ["data-sync-initial-sync-stage"],
          childList: true,
          subtree: true,
        });
      },
      {
        bindingName: REPORT_BINDING_NAME,
        flushBindingName: FLUSH_BINDING_NAME,
        selector: CANVAS_LOCK_SELECTOR,
      },
    );

    // AI-REMOVED 2026-10-05:
    // Reason: 审计生命周期交由受管 context。Trigger: 基座统一清理。
    // Evidence: 安装函数返回收尾动作。Replacement: 下方返回的回调。
    // Risk: Low。Human Review: Required
    // Original code:
    // await use();
    return async () => {

    await Promise.all(context.pages().filter(page => !page.isClosed()).map(async (page) => {
      await page.evaluate(async ({ flushBindingName }) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        });
        const flush = (window as unknown as Record<string, unknown>)[flushBindingName];
        if (typeof flush === "function") {
          await (flush as () => Promise<void>)();
        }
      }, { flushBindingName: FLUSH_BINDING_NAME }).catch(() => undefined);
    }));

    const lifecycleViolations: CanvasLockLifecycleViolation[] = [];
    const intervalLocksByRun = new Map<string, CanvasLockAuditRecord[]>();
    const intervalCompletionByRun = new Map<string, CanvasLockAuditRecord>();

    for (const record of auditRecords) {
      if (record.event.kind === "lock-observed") {
        if (record.event.snapshot.currentRunReason !== "startup") {
          lifecycleViolations.push({
            kind: "unexpected-lock",
            pageUrl: record.pageUrl,
            runId: null,
            detail: record.event,
          });
        }
        continue;
      }
      if (record.event.kind === "interval-lock-observed") {
        const records = intervalLocksByRun.get(record.event.runId) ?? [];
        records.push(record);
        intervalLocksByRun.set(record.event.runId, records);
        continue;
      }
      intervalCompletionByRun.set(record.event.runId, record);
    }

    for (const [runId, lockRecords] of intervalLocksByRun) {
      const completionRecord = intervalCompletionByRun.get(runId);
      if (
        completionRecord === undefined
        || completionRecord.event.kind !== "interval-run-completed"
      ) {
        lifecycleViolations.push({
          kind: "interval-run-incomplete",
          pageUrl: lockRecords[0]?.pageUrl ?? "",
          runId,
          detail: lockRecords,
        });
        continue;
      }

      const completion = completionRecord.event;
      if (!completion.enteredConflict && !completion.didDownload) {
        lifecycleViolations.push({
          kind: "interval-run-no-effective-download",
          pageUrl: completionRecord.pageUrl,
          runId,
          detail: {
            lockRecords,
            completion,
          },
        });
      }
      if (completion.enteredConflict && completion.endedPhase !== "idle") {
        lifecycleViolations.push({
          kind: "conflict-run-did-not-return-idle",
          pageUrl: completionRecord.pageUrl,
          runId,
          detail: completion,
        });
      }
      if (completion.endedPhase === "idle" && completion.lockedAfterIdle) {
        lifecycleViolations.push({
          kind: "canvas-still-locked-after-idle",
          pageUrl: completionRecord.pageUrl,
          runId,
          detail: completion,
        });
      }
    }

    // AI-REMOVED 2026-08-25:
    // Reason: 单点过滤无法判断 interval 锁定最终是否进入冲突、是否实际下载，也无法验证回到 idle 后解锁。
    // Trigger: 用户确认 startup、冲突 interval、idle 解锁及空跑 interval 的四条生命周期语义。
    // Evidence: 同一次冲突同步会经历“门控 → 冲突对话框 → 门控”，旧逻辑会把两个合法门控片段都判错。
    // Replacement: 上方按 runId 聚合的 lifecycleViolations 判定。
    // Risk: Low
    // Human Review: Required
    //
    // Original code:
    // const disallowedViolations = violations.filter(
    //   ({ payload }) =>
    //     (payload as { readonly currentRunReason?: unknown }).currentRunReason !== "startup",
    // );
    // if (disallowedViolations.length === 0) {
    //   return;
    // }
    // await testInfo.attach("canvas-lock-violations", {
    //   body: JSON.stringify(disallowedViolations, null, 2),
    //   contentType: "application/json",
    // });
    // expect(
    //   disallowedViolations,
    //   `除 startup 外，E2E 全程不允许锁定画布，但观察到 ${disallowedViolations.length} 次锁定。`,
    // ).toEqual([]);
    if (lifecycleViolations.length === 0) {
      return;
    }
    await testInfo.attach("canvas-lock-violations", {
      body: JSON.stringify({
        lifecycleViolations,
        auditRecords,
      }, null, 2),
      contentType: "application/json",
    });
    // AI-REMOVED 2026-10-05:
    // Reason: 审计可在 CLI 运行，不能依赖 runner 的 expect。
    // Trigger: 统一审计覆盖。Evidence: lifecycleViolations 已包含完整失败依据。
    // Replacement: 下方等价失败异常。Risk: Low。Human Review: Required
    // Original code:
    // expect(
    //   lifecycleViolations,
    //   `E2E 观察到 ${lifecycleViolations.length} 个不符合生命周期语义的画布锁定。`,
    // ).toEqual([]);
    throw new Error(`E2E 观察到 ${lifecycleViolations.length} 个不符合生命周期语义的画布锁定：${JSON.stringify(lifecycleViolations)}`);
    };
// AI-REMOVED 2026-10-05:
// Reason: 不再注册默认 context 自动 fixture。Trigger: 同上。
// Evidence: harness/fixture.ts 显式管理每个 context。
// Replacement: installCanvasLockAudit 返回的清理回调。
// Risk: Low。Human Review: Required
// Original code:
//   }, { auto: true }],
// });
}
