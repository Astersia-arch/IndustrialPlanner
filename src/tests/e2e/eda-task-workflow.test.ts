import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "playwright/test";
import plant from "../blueprint-planner/fixtures/plant-preload.json" with { type: "json" };

const execute = promisify(execFile);
const profiles = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125 },
  { name: "tablet", width: 711, height: 665, dpr: 3.125 },
  { name: "desktop", width: 2552, height: 1315, dpr: 1 },
] as const;

// 开发验证后独立编写：任务文件导入不得覆盖原蓝图，删除任务不得删除已保存蓝图。
// CLI 独占会话；正式 E2E 的专用服务器由运行器管理，不能与其他 Playwright 任务并行。
test.describe.configure({ mode: "serial" });
for (const profile of profiles) {
  test(`EDA 任务持久化、预览与蓝图库隔离 [${profile.name}]`, async ({ baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const session = `eda-history-${process.pid}-${profile.name}`;
    const output = resolve(testInfo.outputPath("cli"));
    await mkdir(output, { recursive: true });
    const invoke = async (args: string[], log: string) => {
      const result = await execute("playwright-cli", args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      await writeFile(resolve(output, log), result.stdout + result.stderr);
      if (result.stdout.includes("### Error")) throw new Error(result.stdout);
      return result.stdout;
    };
    expect(await invoke(["list"], "sessions-before.log")).toContain("(no browsers)");
    const config = resolve(output, "config.json");
    await writeFile(config, JSON.stringify({ outputDir: output, outputMode: "stdout", browser: {
      launchOptions: { executablePath: chromium.executablePath(), headless: true },
      contextOptions: { viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
        hasTouch: true, locale: "zh-CN" },
    } }));
    const scenario = `async page => {
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      if (${JSON.stringify(profile.name)} === 'desktop') await page.addInitScript(() => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = query => {
          const result = nativeMatchMedia(query);
          if (query !== '(pointer: coarse)' && query !== '(hover: none)') return result;
          return new Proxy(result, {get(target, property) {
            if (property === 'matches') return false;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }});
        };
      });
      await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")});
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner != null);
      await page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('v3-user-settings-dialog') || '{}');
        settings.values = {...settings.values, 'other-experimental-features': true};
        localStorage.setItem('v3-user-settings-dialog', JSON.stringify(settings));
      });
      await page.reload();
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner != null);
      await page.evaluate(async plan => {
        const host = window.__industrialPlannerAppHost;
        const {createSimulationHost} = await import('/src/simulation/simulation-host.ts');
        host.workspace.simulation.dispose();
        createSimulationHost(host.workspace, {engineKind:'dense-v2', blueprintDenseTickRate:2});
        host.blueprintPlannerDialog.setEnabled(true);
        host.blueprintPlannerDialog.open(plan);
      }, ${JSON.stringify(plant.request.plan)});
      const screen = await page.evaluate(() => window.__industrialPlannerAppHost.state.screenProfile);
      assert(screen.deviceClass === ${JSON.stringify(profile.name)} && screen.hasTouch, 'Screen Profile 不匹配');
      const dialog = page.getByRole('dialog').filter({has:page.locator('#blueprint-planner-title')});
      const proposals = dialog.getByRole('spinbutton',{name:'提案次数（万次）'});
      assert(await proposals.inputValue() === '50', '默认必须为五十万次');
      // AI-REMOVED 2026-10-03:
      // Reason: 用户要求 CPU 并发自动调节，界面不再提供数字输入。
      // Trigger: 已授权的自动并发界面变更。
      // Evidence: 三种 Screen Profile 开发验证通过，旧偏好切换为 auto。
      // Replacement: 下方自动状态与单一预算输入断言。
      // Risk: Low。Human Review: Required
      // Original code:
      // assert(await dialog.getByRole('spinbutton',{name:'并发计算数'}).inputValue() === '1', '默认并发数必须为 1');
      // assert(await dialog.getByRole('spinbutton').count() === 2, '任务参数必须提供提案预算和并发数');
      // AI-REMOVED 2026-10-03:
      // Reason: 用户要求把只读自动状态改成 CPU+GPU 并行计算复选框。
      // Trigger: 已通过 Windows 三种 Screen Profile 的开关、续算和恢复验证。
      // Evidence: eda-hybrid-20261003 浏览器证据。Replacement: 下方真实复选框操作。
      // Risk: Low。Human Review: Required
      // Original code:
      // assert(await dialog.locator('output').textContent() === '自动', '默认自动调节并发');
      const parallel = dialog.getByRole('checkbox', {name:'CPU+GPU 并行计算'});
      assert(await parallel.isChecked(), '默认启用自动混合调度');
      await parallel.uncheck();
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.blueprintPlannerDialog.options.concurrency) === 1,
        '关闭并行固定单 Worker');
      await parallel.check();
      assert(await dialog.getByRole('spinbutton').count() === 1, '任务参数只允许手填提案预算');
      for (const [label, value] of [['固体外部供给','warehouse'],['流体外部供给','conduit'],
        ['存取线形态','straight'],['固体成品去向','auto'],['副产物处理','destroy'],['植物循环启动','preload']]) {
        assert(await dialog.getByRole('combobox',{name:label}).inputValue() === value, '默认选项 '+label);
      }
      await proposals.fill('0');
      assert(await dialog.getByRole('button',{name:'开始规划',exact:true}).isDisabled(), '不能低于一万次');
      await proposals.fill('2');
      // AI-REMOVED 2026-10-03:
      // Reason: 并发输入已移除。Trigger: 用户授权自动调节 CPU 并发。
      // Evidence: 界面只保留提案预算输入。Replacement: Host 自动调度。
      // Risk: Low。Human Review: Required
      // Original code:
      // await dialog.getByRole('spinbutton',{name:'并发计算数'}).fill('2');
      await dialog.getByRole('combobox',{name:'固体外部供给'}).selectOption('warehouse');
      await dialog.getByRole('combobox',{name:'流体外部供给'}).selectOption('conduit');
      await dialog.getByRole('combobox',{name:'固体成品去向'}).selectOption('stash');
      // AI-REMOVED 2026-09-30: 用户删除时间预算，Evidence: Options 接口已移除 budgetMs。
      // Replacement: 提案次数输入。Risk: Low。Human Review: Required
      // Original code:
      // await dialog.getByRole('spinbutton',{name:'本轮规划时长（秒）'}).fill('30');
      await dialog.getByRole('button',{name:'开始规划',exact:true}).click();
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.state.activeTaskId === null, null, {timeout:60000});
      const progress = await page.evaluate(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.getTask());
      assert(progress.evaluatedProposals === 20000 && progress.roundEvaluatedProposals === 20000, '按真实提案计数完成一轮');
      assert(progress.activeWorkerCount === 0, '结束后活动并发必须归零');
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.getLastRequest().options.concurrency) === 'auto', '浏览器请求必须使用自动并发');
      const checkpoint = await page.evaluate(() => {
        const h=window.__industrialPlannerAppHost;
        return h.workspace.blueprintPlanner.queries.exportTask(h.blueprintPlannerDialog.viewTaskId).checkpoint;
      });
      // AI-REMOVED 2026-10-03:
      // Reason: 并发 Worker 数不再等于虚拟分片总数，单批预算也不保证所有 Worker 领取任务。
      // Trigger: E2E 在固定 32 分片的当前实现下错误断言总数为 2。
      // Evidence: prepareParallel 固定 32 分片；架构文档允许预算不足时实际并行数低于设置值。
      // Replacement: 下方验证固定分片、实际搜索与尝试数守恒。
      // Risk: Low
      // Human Review: Required
      //
      // Original code:
      // assert(checkpoint.parallel.count === 2 && checkpoint.parallel.shards.every(shard => shard.attempts > 0), '两个分片均须完成搜索');
      assert(checkpoint.parallel.count === 32 && checkpoint.parallel.shards.some(shard => shard.attempts > 0)
        && checkpoint.parallel.shards.reduce((total, shard) => total + shard.attempts, 0) === checkpoint.attempt,
      '固定虚拟分片必须记录实际搜索且总尝试数一致');
      assert(progress.areaHistory.length > 0, '已验证面积曲线必须记录下降点');
      assert(await dialog.getByRole('img',{name:/提案次数与已验证最优面积/}).isVisible(), '任务界面必须显示面积曲线');
      const before = await page.evaluate(() => {
        const h = window.__industrialPlannerAppHost;
        return h.workspace.blueprintPlanner.queries.getResult(h.blueprintPlannerDialog.viewTaskId);
      });
      assert(before !== null && before.folderId === null, '保存前必须能读取真实验证结果');
      await dialog.getByRole('button',{name:'预览蓝图',exact:true}).click();
      assert(await page.getByRole('button',{name:'优化此蓝图',exact:true}).isDisabled(), '优化入口尚未开放');
      await page.screenshot({path:${JSON.stringify(resolve(output, "preview.png"))}});
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.blueprintPlannerDialog.dialogState.visible), '预览时保留规划面板');
      const preview = page.getByRole('dialog').filter({has:page.getByRole('button',{name:'优化此蓝图',exact:true})});
      await preview.getByRole('button',{name:'关闭',exact:true}).click();
      // AI-REMOVED 2026-09-30: 用户要求预览保留面板，Evidence: DialogShell 叠层验证通过。
      // Replacement: 上方真实关闭预览按钮，关闭后直接操作规划面板。Risk: Low。Human Review: Required
      // Original code:
      // await page.evaluate(() => window.__industrialPlannerAppHost.blueprintPreview.close());
      // await page.getByRole('button',{name:'规划',exact:true}).click();
      assert(await dialog.isVisible(), '关闭预览后规划面板仍可操作');
      await dialog.getByRole('button',{name:'保存蓝图',exact:true}).click();
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.state.activeTaskId === null);
      assert(await dialog.getByRole('button',{name:'保存蓝图',exact:true}).isDisabled(), '保存后不能重复保存相同结果');
      const waitingDownload = page.waitForEvent('download');
      await dialog.getByRole('button',{name:'下载任务',exact:true}).click();
      await (await waitingDownload).saveAs(${JSON.stringify(resolve(output, "task.json"))});
      await dialog.locator('input[type=file]').setInputFiles(${JSON.stringify(resolve(output, "task.json"))});
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.listTasks().length === 2);
      const imported = await page.evaluate(() => {
        const h = window.__industrialPlannerAppHost;
        return h.workspace.blueprintPlanner.queries.getResult(h.blueprintPlannerDialog.viewTaskId);
      });
      const importedProgress = await page.evaluate(() => { const h=window.__industrialPlannerAppHost;
        return h.workspace.blueprintPlanner.queries.getTask(h.blueprintPlannerDialog.viewTaskId); });
      assert(importedProgress.evaluatedProposals === progress.evaluatedProposals, '导入保留累计提案');
      assert(importedProgress.areaHistory.length === progress.areaHistory.length, '导入保留面积曲线');
      assert(imported.folderId === null && imported.blueprint.blueprintId !== before.blueprint.blueprintId, '导入任务不能覆盖原蓝图');
      await page.reload();
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner?.queries.listTasks().length === 2);
      await page.getByRole('button',{name:'规划',exact:true}).click();
      await page.getByRole('button').filter({hasText:${JSON.stringify(plant.request.plan.name)}}).first().click();
      const restoredProgress = await page.evaluate(() => {
        const h=window.__industrialPlannerAppHost;
        return h.workspace.blueprintPlanner.queries.getTask(h.blueprintPlannerDialog.viewTaskId);
      });
      assert(restoredProgress.areaHistory.length === progress.areaHistory.length, '刷新保留面积曲线');
      await parallel.uncheck();
      await proposals.fill('1');
      await dialog.getByRole('button',{name:'继续规划',exact:true}).click();
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.state.activeTaskId === null, null, {timeout:60000});
      const continued = await page.evaluate(() => {const h=window.__industrialPlannerAppHost, p=h.workspace.blueprintPlanner;
        return {request:p.queries.getLastRequest(h.blueprintPlannerDialog.viewTaskId),progress:p.queries.getTask(h.blueprintPlannerDialog.viewTaskId)};});
      assert(continued.request.options.concurrency === 1, '续算保留关闭并行的选择');
      assert(continued.progress.evaluatedProposals === progress.evaluatedProposals + 10000, '切换执行模式不丢累计预算');
      await page.screenshot({path:${JSON.stringify(resolve(output, "history.png"))}});
      return {passed:true, savedBlueprintId:before.blueprint.blueprintId, screen, snapshot:await page.locator('body').ariaSnapshot()};
    }`;
    try {
      await invoke([`-s=${session}`, "open", "about:blank", `--config=${config}`], "open.log");
      const result = await invoke([`-s=${session}`, "run-code", scenario], "workflow.log");
      expect(result).toMatch(/"passed":\s*true/);
      const task = JSON.parse(await readFile(resolve(output, "task.json"), "utf8"));
      const success = resolve(".temp/eda/success", `${session}-${Date.now()}`);
      await mkdir(success, { recursive: true });
      await Promise.all([
        writeFile(resolve(success, "task.json"), JSON.stringify(task)),
        writeFile(resolve(success, "blueprint.json"), JSON.stringify(task.checkpoint.result.blueprint)),
        writeFile(resolve(success, "input.json"), JSON.stringify(task.request)),
        writeFile(resolve(success, "report.json"), JSON.stringify({ progress: task.progress,
          report: task.checkpoint.best.report, metrics: task.checkpoint.result.metrics, ticksPerSecond: 2 })),
      ]);
      await invoke([`-s=${session}`, "run-code", "async page => { await page.getByRole('button',{name:'删除任务',exact:true}).click(); }"], "delete.log");
      await invoke([`-s=${session}`, "dialog-accept"], "confirm.log");
      const deleted = await invoke([`-s=${session}`, "run-code", `async page => {
        await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.listTasks().length === 1);
        const count = await page.evaluate(async () => {
          const {listBlueprintDirectory} = await import('/src/shared/storage/blueprint-storage.ts');
          const directory = await listBlueprintDirectory();
          const folder = directory.folders.find(entry => entry.name === '自动规划');
          if (!folder) throw Error('保存的蓝图文件夹丢失');
          const saved = await listBlueprintDirectory(folder.folderId);
          return saved.blueprints.length;
        });
        if (count !== 1) throw Error('删除任务影响了蓝图库');
        return {passed:true};
      }`], "deleted.log");
      expect(deleted).toMatch(/"passed":\s*true/);
    } finally {
      try { await invoke([`-s=${session}`, "close"], "close.log"); }
      finally { expect(await invoke(["list"], "sessions-after.log")).not.toContain(session); }
    }
  });
}
