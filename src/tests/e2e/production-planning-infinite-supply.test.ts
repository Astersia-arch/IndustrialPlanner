import { SCREEN_PROFILES as profiles } from "./harness/profiles";
// AI-REMOVED 2026-10-05:
// Reason: CLI 配置、进程检查与清理收敛到受管会话。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 六个用例复制同一套启动与收尾逻辑。
// Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
// Risk: Low。Human Review: Required
// Original code:
// import { execFile } from "node:child_process";

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// AI-REMOVED 2026-10-05:
// Reason: CLI 配置、进程检查与清理收敛到受管会话。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 六个用例复制同一套启动与收尾逻辑。
// Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
// Risk: Low。Human Review: Required
// Original code:
// import { promisify } from "node:util";

import { expect, test } from "./harness/fixture";

// AI-REMOVED 2026-10-05:
// Reason: CLI 配置、进程检查与清理收敛到受管会话。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 六个用例复制同一套启动与收尾逻辑。
// Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
// Risk: Low。Human Review: Required
// Original code:
// const execute = promisify(execFile);

// AI-REMOVED 2026-10-05:
// Reason: 屏幕尺寸、DPR 与触控设置收敛到唯一来源。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 当前用例重复管理相同运行资源。
// Replacement: harness/profiles.ts
// Risk: Low。Human Review: Required
// Original code:
// const profiles = [
//   { name: "mobile", width: 764, height: 345, dpr: 3.125 },
//   { name: "tablet", width: 711, height: 665, dpr: 3.125 },
//   { name: "desktop", width: 2552, height: 1315, dpr: 1 },
// ] as const;

// 三档开发验证完成后独立编写；会话逐项关闭，正式测试服务由项目运行器管理。
// AI-REMOVED 2026-10-05:
// Reason: 独立屏幕或主题用例不应因前项失败而跳过。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 当前用例重复管理相同运行资源。
// Replacement: playwright.config.ts 的 workers: 1
// Risk: Low。Human Review: Required
// Original code:
// test.describe.configure({ mode: "serial" });
for (const profile of profiles) {
  test(`自然资源显式无限外供及有限供给恢复 [${profile.name}]`, async ({ baseURL, browserSession }, _testInfo) => {
    test.setTimeout(180_000);
    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // const session = `planning-infinity-${process.pid}-${profile.name}`;
    const cli = await browserSession.openCli(profile);
    const directory = cli.directory;
    const _session = cli.session;

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // const directory = resolve(testInfo.outputPath("cli"));

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // await mkdir(directory, { recursive: true });

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // const invoke = async (args: string[], log: string) => {
    //       const result = await execute("playwright-cli", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    //       await writeFile(resolve(directory, log), result.stdout + result.stderr);
    //       if (result.stdout.includes("### Error")) throw new Error(result.stdout);
    //       return result.stdout;
    //     };

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // expect(await invoke(["list"], "before.log")).toContain("(no browsers)");

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // const before = await execute("ps", ["-eo", "pid,ppid,args"]);

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // expect(before.stdout).not.toMatch(/playwright-core.*daemon/);

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // const config = resolve(directory, "config.json");

    // AI-REMOVED 2026-10-05:
    // Reason: CLI 配置、进程检查与清理收敛到受管会话。
    // Trigger: 用户授权统一 E2E 基座。
    // Evidence: 六个用例复制同一套启动与收尾逻辑。
    // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
    // Risk: Low。Human Review: Required
    // Original code:
    // await writeFile(config, JSON.stringify({ outputDir: directory, outputMode: "stdout", browser: {
    //       launchOptions: { executablePath: chromium.executablePath(), headless: true },
    //       contextOptions: {
    //         viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
    //         hasTouch: true, isMobile: profile.name !== "desktop", locale: "zh-CN",
    //       },
    //     } }));

    const scenario = resolve(directory, "scenario.js");
    await writeFile(scenario, `async page => {
      const assert = (value, message) => { if (!value) throw Error(message); };
      const press = async locator => ${profile.name === "desktop" ? "locator.click()" : "locator.tap()"};
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // AI-REMOVED 2026-10-05:
      // Reason: 桌面触控与主指针设置只保留一个实现。
      // Trigger: E2E 基座迁移。Evidence: ManagedCli.open 已安装统一 Screen Profile。
      // Replacement: harness/profiles.ts installDesktopPointer。Risk: Low。Human Review: Required
      // Original code:
      // if (${JSON.stringify(profile.name)} === 'desktop') await page.addInitScript(() => {
      //   const original = window.matchMedia.bind(window);
      //   window.matchMedia = query => {
      //     const result = original(query);
      //     if (query !== '(pointer: coarse)' && query !== '(hover: none)') return result;
      //     return new Proxy(result, { get(target, property) {
      //       if (property === 'matches') return false;
      //       const value = Reflect.get(target, property, target);
      //       return typeof value === 'function' ? value.bind(target) : value;
      //     } });
      //   };
      // });
      const openPlanning = async () => {
        const toolbox = page.getByRole('button', { name: '工具箱', exact: true });
        if (await toolbox.getAttribute('aria-pressed') !== 'true') await press(toolbox);
        await press(page.getByText('产线规划', { exact: true }));
        await page.getByRole('button', { name: '计算', exact: true }).waitFor({ state: 'visible' });
      };
      try {
        await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")});
        await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.editor != null);
        const screen = await page.evaluate(() => window.__industrialPlannerAppHost.state.screenProfile);
        assert(screen.deviceClass === ${JSON.stringify(profile.name)} && screen.hasTouch, 'Screen Profile 不匹配');
        const natural = await page.evaluate(async () => {
          const registry = window.__industrialPlannerAppHost.workspace.registry;
          const ids = registry.itemDefinitions.filter(item => item.tags.includes('自然资源')).map(item => item.id);
          const { savePlannerState, createDefaultPlannerSessionState } = await import('/src/shared/storage/planner-storage.ts');
          await savePlannerState({
            targets: [{id: 'target', itemId: 'item_gas_xiranite', perMinute: 120}],
            supplies: ids.map(itemId => ({id: itemId, itemId, perMinute: 30})),
            displayMode: 'item', viewMode: 'tree', useModules: false, recipeChoices: {}, recipeChoicesDemandSignature: null,
            sourceConfig: {waterPolicy: 'use-byproduct', acidPolicy: 'use-byproduct', sewagePolicy: 'external-supply',
              waterPurifierPolicy: 'disabled', includeDeviceMinimumConsumption: 'fractional'},
            session: createDefaultPlannerSessionState(),
          });
          return ids;
        });
        assert(natural.includes('item_gas_xiranite'), '息壤气必须属于被测自然资源');
        await openPlanning();
        const before = await page.locator('body').ariaSnapshot();
        const toggles = page.getByRole('button', {name: '无限供给', exact: true});
        await toggles.last().waitFor({state: 'visible'});
        assert(await toggles.count() === natural.length, '原料行数量不匹配');
        for (let i = 0; i < natural.length; i++) {
          const button = toggles.nth(i);
          await button.scrollIntoViewIfNeeded();
          assert(!(await button.isDisabled()), natural[i] + ' 不允许无限外供');
          assert(await button.getAttribute('aria-pressed') === 'false', natural[i] + ' 不应默认无限');
          await press(button);
          assert(await button.getAttribute('aria-pressed') === 'true', natural[i] + ' 无限切换失败');
          assert(await button.locator('..').locator('input').inputValue() === '∞', '原料应显示无限');
        }
        await page.waitForFunction(async () => {
          const state = await (await import('/src/shared/storage/planner-storage.ts')).loadPlannerState();
          return state?.supplies.length > 0 && state.supplies.every(supply => supply.isInfinite === true);
        }, undefined, {polling: 100});
        await page.reload();
        await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.editor != null);
        await openPlanning();
        await toggles.last().waitFor({state: 'visible'});
        for (let i = 0; i < natural.length; i++) {
          assert(await toggles.nth(i).getAttribute('aria-pressed') === 'true', natural[i] + ' 无限状态未持久化');
        }
        const gasToggle = toggles.nth(natural.indexOf('item_gas_xiranite'));
        await gasToggle.scrollIntoViewIfNeeded();
        await press(gasToggle);
        assert(await gasToggle.locator('..').locator('input').inputValue() === '30', '取消无限应恢复有限数量');
        await press(page.getByRole('button', {name: '计算', exact: true}));
        const gatheringName = await page.evaluate(() => {
          const host = window.__industrialPlannerAppHost;
          return host.actions.translate(host.workspace.registry.entityDefinitions.find(entity => entity.id === 'gas_pump_1').nameKey);
        });
        const gathering = page.getByRole('dialog').last().getByText(gatheringName, {exact: true});
        await gathering.waitFor({state: 'visible'});
        await press(page.getByRole('button', {name: '修改', exact: true}));
        await gasToggle.scrollIntoViewIfNeeded();
        await press(gasToggle);
        await press(page.getByRole('button', {name: '计算', exact: true}));
        await page.getByRole('button', {name: '移除外部供给', exact: true}).waitFor({state: 'visible'});
        assert(await page.getByRole('button', {name: '设为原料', exact: true}).count() === 0, '无限外供不应继续采集');
        await page.screenshot({path: ${JSON.stringify(resolve(directory, "external-result.png"))}});
        assert(errors.length === 0, '页面错误: ' + JSON.stringify(errors));
        return {passed: true, screen, natural, before, after: await page.locator('body').ariaSnapshot()};
      } catch (error) {
        await page.screenshot({path: ${JSON.stringify(resolve(directory, "failure.png"))}}).catch(() => {});
        throw error;
      }
    }`);
    /* AI-CORRECTION 2026-10-05: 会话由 fixture 收尾，原 finally 原文保留在块后。 */
    {
      // AI-REMOVED 2026-10-05:
      // Reason: CLI 配置、进程检查与清理收敛到受管会话。
      // Trigger: 用户授权统一 E2E 基座。
      // Evidence: 六个用例复制同一套启动与收尾逻辑。
      // Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
      // Risk: Low。Human Review: Required
      // Original code:
      // await invoke([`-s=${session}`, "open", "about:blank", `--config=${config}`], "open.log");

      expect(await cli.runJson(await readFile(scenario, "utf8"), "scenario.log"))
        .toMatchObject({ passed: true });
    }
// AI-REMOVED 2026-10-05:
// Reason: CLI 配置、进程检查与清理收敛到受管会话。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 六个用例复制同一套启动与收尾逻辑。
// Replacement: harness/fixture.ts ManagedCli 与 scripts/browser-test/runtime.mjs。
// Risk: Low。Human Review: Required
// Original code:
// finally {
//       try {
//         await invoke([`-s=${session}`, "close"], "close.log");
//       } finally {
//         expect(await invoke(["list"], "after.log")).not.toContain(session);
//         const processes = await execute("ps", ["-eo", "pid,ppid,args"]);
//         await writeFile(resolve(directory, "cleanup-processes.log"), processes.stdout);
//         expect(processes.stdout).not.toContain(session);
//       }
//     }

  });
}
