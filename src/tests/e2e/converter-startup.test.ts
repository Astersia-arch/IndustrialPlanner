import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "playwright/test";
import input from "../blueprint-planner/fixtures/converter-startup-liquid.json" with { type: "json" };

const execute = promisify(execFile);
const profiles = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125 },
  { name: "tablet", width: 711, height: 665, dpr: 3.125 },
  { name: "desktop", width: 2552, height: 1315, dpr: 1 },
] as const;

// 三档开发验证完成后独立编写，使用原生选择事件和真实任务序列化。
test.describe.configure({ mode: "serial" });
for (const profile of profiles) {
  test(`转化设备启动策略、默认阻断与持久化 [${profile.name}]`, async ({ baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const output = resolve(testInfo.outputPath("cli"));
    const session = `converter-startup-${process.pid}-${profile.name}`;
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
    const ownedDaemons = async () => (await execute("ps", ["-eo", "pid,args"])).stdout.split("\n")
      .filter(line => line.includes("cliDaemon.js") && line.includes(session)).map(line => Number(line.trim().split(/\s+/)[0]));
    try {
      await invoke([`-s=${session}`, "open", `--config=${config}`], "open.log");
      const result = await invoke([`-s=${session}`, "run-code", `async page => {
        const assert = (condition, message) => { if (!condition) throw Error(message); };
        await page.addInitScript(desktop => {
          localStorage.setItem('v3-user-settings-dialog', JSON.stringify({ values: { 'other-experimental-features': true } }));
          if (!desktop) return;
          const nativeMatchMedia = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const media = nativeMatchMedia(query);
            if (query !== '(pointer: coarse)' && query !== '(hover: none)') return media;
            return new Proxy(media, { get(target, key) {
              if (key === 'matches') return false;
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          };
        }, ${JSON.stringify(profile.name === "desktop")});
        const request = ${JSON.stringify(input)};
        await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")});
        const ready = async () => page.waitForFunction(input => {
          try {
            window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.exportDraft({ ...input,
              options: { ...input.options, converterStartup: 'manual' } });
            return true;
          } catch { return false; }
        }, request);
        await ready();
        await page.evaluate(request => {
          const c = window.__industrialPlannerAppHost.blueprintPlannerDialog;
          c.setEnabled(true); c.open(request.plan, request.options);
        }, request);
        const screen = await page.evaluate(() => window.__industrialPlannerAppHost.state.screenProfile);
        assert(screen.deviceClass === ${JSON.stringify(profile.name)} && screen.hasTouch, 'Screen Profile');
        const dialog = page.getByRole('dialog').filter({ has: page.locator('#blueprint-planner-title') });
        const select = dialog.getByRole('combobox', { name: '固液气转换器启动', exact: true });
        const warning = dialog.getByText('液化息壤 自循环 需要外部启动器启动，请调整启动设置。', { exact: true });
        const start = dialog.getByRole('button', { name: '开始规划', exact: true });
        assert(await select.inputValue() === 'reject', '旧任务缺省必须拒绝启动');
        assert(await warning.isVisible() && await start.isDisabled(), '缺省显示错误并阻断');
        await page.screenshot({ path: ${JSON.stringify(resolve(output, "reject.png"))} });
        for (const mode of ['manual', 'tank']) {
          await select.selectOption(mode);
          assert(await warning.count() === 0 && !(await start.isDisabled()), mode + ' 应取消自循环阻断');
          const persisted = await page.evaluate(async mode => {
            const h = window.__industrialPlannerAppHost, p = h.workspace.blueprintPlanner;
            const file = p.queries.exportDraft(h.blueprintPlannerDialog.getRequest());
            const id = await p.actions.importTask(file);
            return file.request.options.converterStartup === mode && p.queries.getLastRequest(id).options.converterStartup === mode;
          }, mode);
          assert(persisted, mode + ' 必须进入任务文件并可导入');
          await page.screenshot({ path: ${JSON.stringify(resolve(output, "allowed"))} + '-' + mode + '.png' });
        }
        await page.reload(); await ready();
        await page.evaluate(plan => {
          const c = window.__industrialPlannerAppHost.blueprintPlannerDialog;
          c.setEnabled(true); c.open(plan);
        }, request.plan);
        assert(await select.inputValue() === 'tank', '刷新保留启动偏好');
        await select.selectOption('reject');
        assert(await warning.isVisible() && await start.isDisabled(), '恢复拒绝后重新阻断');
        return { passed: true };
      }`], "validation.log");
      expect(result).toMatch(/"passed":\s*true/);
    } finally {
      try { await invoke([`-s=${session}`, "close"], "close.log"); }
      finally {
        for (const pid of await ownedDaemons()) {
          try { process.kill(pid, "SIGTERM"); }
          catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
        }
        await expect.poll(ownedDaemons).toEqual([]);
        expect(await invoke(["list"], "sessions-after.log")).toContain("(no browsers)");
      }
    }
  });
}
