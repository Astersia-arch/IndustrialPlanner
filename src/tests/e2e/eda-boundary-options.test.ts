import { resolve } from "node:path";
import { expect, SCREEN_PROFILES, test } from "./harness/fixture";
import separator from "../blueprint-planner/fixtures/separator-core.json" with { type: "json" };

// 三档开发验证完成后独立编写；真实下拉框负责修改，刷新与旧配置迁移均从持久层恢复。
for (const profile of SCREEN_PROFILES) {
  test(`EDA 存取线形态默认值、持久化和旧选项迁移 [${profile.name}]`, async ({ baseURL, browserSession }) => {
    test.setTimeout(150_000);
    const cli = await browserSession.openCli(profile);
    const result = await cli.runJson(`async page => {
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('industrial-planner.experimental.eda', 'true'));
      await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")}, {waitUntil:'domcontentloaded'});
      const open = async () => {
        await page.waitForFunction(() => !!window.__industrialPlannerAppHost?.workspace.blueprintPlanner);
        await page.evaluate(plan => window.__industrialPlannerAppHost.blueprintPlannerDialog.open(plan), ${JSON.stringify(separator.request.plan)});
      };
      await open();
      const field = page.getByRole('combobox', {name:'存取线形态', exact:true});
      await field.scrollIntoViewIfNeeded();
      const initial = await field.inputValue();
      const labels = await field.locator('option').allTextContents();
      await field.selectOption('corner');
      const corner = await field.inputValue();
      await field.selectOption('u-shaped');
      const uShape = await field.inputValue();
      await page.reload({waitUntil:'domcontentloaded'}); await open();
      await field.scrollIntoViewIfNeeded();
      const persisted = await field.inputValue();
      await page.screenshot({path:${JSON.stringify(resolve(cli.directory, "u-shaped.png"))}});
      await page.evaluate(() => localStorage.setItem('industrial-planner.eda.options', JSON.stringify({warehouseBus:'free'})));
      await page.reload({waitUntil:'domcontentloaded'}); await open();
      await field.scrollIntoViewIfNeeded();
      return {initial, labels, corner, uShape, persisted, migrated:await field.inputValue(), errors};
    }`);
    expect(result).toEqual({ initial: "straight", labels: ["直线存取线", "直角存取线", "U型存取线"],
      corner: "corner", uShape: "u-shaped", persisted: "u-shaped", migrated: "corner", errors: [] });
  });
}
