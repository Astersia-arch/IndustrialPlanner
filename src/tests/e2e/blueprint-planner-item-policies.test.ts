import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "playwright/test";
import type { PlannerCheckpoint } from "@/blueprint-planner/task-checkpoint";
import type { BlueprintPlannerTaskFile } from "@/domain/blueprint-planner";
import environment from "../blueprint-planner/fixtures/environment-supply.json" with { type: "json" };

const execute = promisify(execFile);
const profiles = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125 },
  { name: "tablet", width: 711, height: 665, dpr: 3.125 },
  { name: "desktop", width: 2552, height: 1315, dpr: 1 },
] as const;

// 三档开发验收完成后另行编写；测试只管理自己的 CLI 会话，服务由项目运行器负责。
test.describe.configure({ mode: "serial" });
for (const profile of profiles) {
  test(`环境树表、草稿下载与逐物品规则持久化 [${profile.name}]`, async ({ baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const directory = resolve(testInfo.outputPath("cli")), session = `eda-policies-${process.pid}-${profile.name}`;
    await mkdir(directory, { recursive: true });
    const invoke = async (args: string[], log: string) => {
      const result = await execute("playwright-cli", args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      await writeFile(resolve(directory, log), result.stdout + result.stderr);
      if (result.stdout.includes("### Error")) throw new Error(result.stdout);
      return result.stdout;
    };
    expect(await invoke(["list"], "sessions-before.log")).toContain("(no browsers)");
    const before = await execute("ps", ["-eo", "pid,ppid,args"]);
    expect(before.stdout).not.toMatch(/playwright-core.*daemon|chrome-headless-shell/);
    const config = resolve(directory, "config.json"), scenario = resolve(directory, "scenario.js");
    await writeFile(config, JSON.stringify({ outputDir: directory, outputMode: "stdout", browser: {
      launchOptions: { executablePath: chromium.executablePath(), headless: true },
      contextOptions: { viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr, hasTouch: true, locale: "zh-CN" },
    } }));
    await writeFile(scenario, `async page => {
      const assert = (value, message) => { if (!value) throw Error(message); };
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      if (${JSON.stringify(profile.name)} === 'desktop') await page.addInitScript(() => {
        const original = window.matchMedia.bind(window);
        window.matchMedia = query => {
          const result = original(query);
          return query === '(pointer: coarse)' || query === '(hover: none)' ? new Proxy(result, {get(target, property) {
            if (property === 'matches') return false;
            const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
          }}) : result;
        };
      });
      await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")});
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner != null);
      await page.evaluate(async plan => {
        const host = window.__industrialPlannerAppHost;
        const { createSimulationHost } = await import('/src/simulation/simulation-host.ts');
        host.workspace.simulation.dispose(); createSimulationHost(host.workspace, {engineKind:'dense-v2',blueprintDenseTickRate:2});
        host.blueprintPlannerDialog.setEnabled(true); host.blueprintPlannerDialog.open(plan);
      }, ${JSON.stringify(environment.plan)});
      const screen = await page.evaluate(() => window.__industrialPlannerAppHost.state.screenProfile);
      assert(screen.deviceClass === ${JSON.stringify(profile.name)} && screen.hasTouch, '屏幕档位不匹配');
      const dialog = page.getByRole('dialog').filter({has:page.locator('#blueprint-planner-title')});
      const tree = dialog.getByRole('region', {name:'环境供料'});
      assert(await tree.getByRole('row').count() === 4, '环境依赖树缺少上游');
      await tree.getByRole('button', {name:'折叠',exact:true}).click();
      assert(await tree.getByRole('row').count() === 2, '环境树没有折叠');
      await tree.getByRole('button', {name:'展开',exact:true}).click();
      await tree.getByRole('button', {name:'外部供给',exact:true}).click();
      assert(await tree.getByRole('row').count() === 2, '外供仍展示自产上游');
      const boundary = dialog.getByRole('region', {name:'物品物流'});
      const connection = boundary.getByRole('combobox', {name:'酸气 · 外部接入',exact:true});
      await connection.selectOption('external');
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.blueprintPlannerDialog.options.itemPolicies
        .find(policy => policy.itemId === 'item_gas_acid').supply) === 'external', '逐物品规则没有进入状态');
      await connection.selectOption('conduit');
      assert(!(await tree.innerText()).includes('registry.recipe.'), '界面泄露配方 key');
      await tree.evaluate(element => element.scrollIntoView({block:'start'}));
      await page.screenshot({path:${JSON.stringify(resolve(directory, "configured.png"))}});
      const before = await dialog.ariaSnapshot();
      await dialog.getByRole('spinbutton', {name:'提案次数（万次）'}).fill('1');
      await dialog.getByRole('checkbox', {name:'CPU+GPU 并行计算'}).uncheck();
      // 2026-10-04：三档草稿下载开发验证完成后独立补充正式回归，下载不得偷偷启动计算。
      const draftDownload = dialog.getByRole('button', {name:'下载任务',exact:true});
      assert(await draftDownload.isEnabled(), '未启动草稿不可下载');
      assert(await dialog.getByRole('button', {name:'删除任务',exact:true}).count() === 0, '草稿误显示删除历史任务');
      const pendingDownload = page.waitForEvent('download');
      await draftDownload.click();
      await (await pendingDownload).saveAs(${JSON.stringify(resolve(directory, "draft.eda-task.json"))});
      const draftState = await page.evaluate(() => {
        const host = window.__industrialPlannerAppHost;
        return {taskId:host.blueprintPlannerDialog.viewTaskId, activeTaskId:host.workspace.blueprintPlanner.state.activeTaskId,
          historyCount:host.workspace.blueprintPlanner.queries.listTasks().length};
      });
      assert(draftState.taskId === null && draftState.activeTaskId === null && draftState.historyCount === 0,
        '草稿下载修改了任务历史或启动了计算');
      await draftDownload.scrollIntoViewIfNeeded();
      await page.screenshot({path:${JSON.stringify(resolve(directory, "draft-download.png"))}});
      await dialog.getByRole('button', {name:'开始规划',exact:true}).click();
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.state.activeTaskId === null, null, {timeout:120000});
      const task = await page.evaluate(() => { const host = window.__industrialPlannerAppHost;
        return host.workspace.blueprintPlanner.queries.exportTask(host.blueprintPlannerDialog.viewTaskId); });
      assert(task.progress.evaluatedProposals > 0, '规划未进入实际搜索');
      assert(task.request.plan.supplyPolicies.find(policy => policy.itemId === 'item_gas_acid').source === 'external', '来源未保存');
      assert(task.request.options.itemPolicies.find(policy => policy.itemId === 'item_gas_acid').supply === 'conduit', '接入未保存');
      assert(await connection.isDisabled(), '已开始任务可以改写规则');
      await dialog.getByRole('button', {name:'重新规划',exact:true}).click();
      assert(await connection.isEnabled(), '新草稿不可编辑');
      assert(await connection.inputValue() === 'conduit', '重新规划丢失规则');
      await tree.getByRole('button', {name:'内部生产',exact:true}).click();
      assert(await connection.count() === 0, '自产气体仍要求外接设施');
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.listTasks().length) === 1, '编辑草稿覆盖历史');
      const overflow = await dialog.evaluate(element => [...element.querySelectorAll('[class*="_scroll_"]')]
        .some(child => child.scrollWidth > child.clientWidth + 2));
      assert(!overflow, '内容区域横向溢出');
      assert(errors.length === 0, errors.join(' | '));
      return {passed:true,screen,before,after:await dialog.ariaSnapshot(),task};
    }`);
    try {
      await invoke([`-s=${session}`, "open", "about:blank", `--config=${config}`], "open.log");
      const output = await invoke([`-s=${session}`, "run-code", `--filename=${scenario}`], "scenario.log");
      expect(output).toContain('"passed":true');
      const result = JSON.parse(output.slice(output.indexOf("### Result") + 10, output.indexOf("### Ran Playwright code")).trim()) as { task: BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint } };
      const draft = JSON.parse(await readFile(resolve(directory, "draft.eda-task.json"), "utf8")) as BlueprintPlannerTaskFile & { checkpoint: PlannerCheckpoint };
      expect(draft.request).toEqual(result.task.request);
      expect(draft.progress).toMatchObject({ status: "waiting", elapsedMs: 0, evaluatedProposals: 0, candidateCount: 0 });
      expect(draft.checkpoint).toMatchObject({ attempt: 0, evaluations: 0, best: null, pendingCandidate: null, result: null });
      if (result.task.checkpoint.best) {
        const success = resolve(".temp/eda/success", `${session}-${Date.now()}`);
        await mkdir(success, { recursive: true });
        await Promise.all([
          writeFile(resolve(success, "task.json"), JSON.stringify(result.task, null, 2)),
          writeFile(resolve(success, "input.json"), JSON.stringify(result.task.request, null, 2)),
          writeFile(resolve(success, "blueprint.json"), JSON.stringify(result.task.checkpoint.best.candidate.execution.blueprint, null, 2)),
          writeFile(resolve(success, "report.json"), JSON.stringify({ engineKind: "dense-v2", ticksPerSecond: 2,
            progress: result.task.progress, report: result.task.checkpoint.best.report }, null, 2)),
        ]);
      }
    } finally {
      try { await invoke([`-s=${session}`, "close"], "close.log"); }
      finally {
        expect(await invoke(["list"], "sessions-after.log")).not.toContain(session);
        const after = await execute("ps", ["-eo", "pid,ppid,args"]);
        await writeFile(resolve(directory, "processes-after.log"), after.stdout);
        expect(after.stdout.split("\n").filter(line => line.includes(session) && /cli-daemon|playwright-core/.test(line))).toEqual([]);
      }
    }
  });
}
