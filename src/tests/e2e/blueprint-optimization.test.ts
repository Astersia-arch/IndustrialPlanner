import { resolve } from "node:path";
import { expect, test } from "./harness/fixture";
import { SCREEN_PROFILES } from "./harness/profiles";
import plant from "../fixtures/blueprints/blueprint-planner/blueprint-optimization/plant-cycle.schema6.json" with { type: "json" };
import unknown from "../fixtures/blueprints/blueprint-planner/blueprint-optimization/unknown-entry.schema6.json" with { type: "json" };

// 三种尺寸开发验证后独立编写；固定蓝图只用于布景，识别和边界配置均通过真实 UI。
for (const profile of SCREEN_PROFILES) {
  test(`原图识别基线恢复与未知断头拒绝 [${profile.name}]`, async ({ browserSession, baseURL }) => {
    test.setTimeout(180_000);
    const cli = await browserSession.openCli(profile);
    const result = await cli.runJson(`async page => {
      const assert = (condition, message) => { if (!condition) throw Error(message); };
      await page.addInitScript(() => {
        localStorage.setItem('industrial-planner.experimental.eda', 'true');
        localStorage.setItem('v3-user-settings-dialog', JSON.stringify({values:{'other-experimental-features':true}}));
      });
      await page.goto(${JSON.stringify(baseURL ?? "http://127.0.0.1:4174")});
      await page.waitForFunction(() => window.__test__?.readiness().assembled);
      const screen = await page.evaluate(() => window.__test__.getAppState().screen);
      assert(screen.deviceClass === ${JSON.stringify(profile.name)} && screen.hasTouch
        && screen.viewportWidth === ${profile.width} && screen.viewportHeight === ${profile.height}
        && screen.devicePixelRatio === ${profile.dpr}, '屏幕配置不匹配');
      await page.evaluate(async record => {
        const {saveBlueprintDocument}=await import('/src/shared/storage/blueprint-storage.ts');
        const saved=await saveBlueprintDocument(record,{parentFolderId:null});
        window.__industrialPlannerAppHost.blueprintPreview.open(saved);
      }, ${JSON.stringify(plant)});
      await page.getByRole('button', {name:'优化此蓝图',exact:true}).click();
      const dialog = page.getByRole('dialog').filter({has:page.locator('#blueprint-planner-title')});
      const identify = dialog.getByRole('button', {name:'识别蓝图',exact:true});
      await identify.waitFor();
      await page.screenshot({path:${JSON.stringify(resolve(cli.directory, "boundaries.png"))}});
      await identify.click();
      await dialog.getByLabel('原图净产率').waitFor({timeout:60000});
      const baseline = await page.evaluate(() => {
        const h=window.__industrialPlannerAppHost, p=h.workspace.blueprintPlanner, id=h.blueprintPlannerDialog.viewTaskId;
        return {task:p.queries.getTask(id), result:p.queries.getResult(id), file:p.queries.exportTask(id)};
      });
      assert(baseline.task.status === 'waiting' && baseline.result.metrics.area === 150, '原图未成为保底结果');
      assert(baseline.result.measuredOutputs.length === 1 && baseline.result.measuredOutputs[0].perMinute === 30, '净产率基线错误');
      assert(baseline.file.checkpoint.blueprintBaseline.report.engineKind === 'dense-v2', '识别未固定使用 Dense');
      assert(JSON.stringify(baseline.result.blueprint.entities) === JSON.stringify(${JSON.stringify(plant.entities)}), '识别修改了原图设备');
      await page.screenshot({path:${JSON.stringify(resolve(cli.directory, "baseline.png"))}});
      await dialog.getByRole('button', {name:'保存蓝图',exact:true}).click();
      await page.waitForFunction(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.state.activeTaskId === null);
      const saved = await page.evaluate(async sourceId => {
        const {readBlueprintRecord,listBlueprintDirectory}=await import('/src/shared/storage/blueprint-storage.ts');
        const source=await readBlueprintRecord(sourceId), root=await listBlueprintDirectory();
        const folder=root.folders.find(entry => entry.name === '自动规划');
        return {source,copies:folder ? await listBlueprintDirectory(folder.folderId) : null};
      }, ${JSON.stringify(plant.blueprintId)});
      assert(saved.source.parentFolderId === null && saved.copies?.blueprints.length === 1
        && saved.copies.blueprints[0].blueprintId !== saved.source.blueprintId, '保存保底结果不能覆盖或移动原蓝图');
      await page.reload();
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner?.queries.listTasks().length === 1, null, {timeout:60000});
      const restored = await page.evaluate(() => {
        const p=window.__industrialPlannerAppHost.workspace.blueprintPlanner;
        return p.queries.getResult(p.queries.listTasks()[0].taskId);
      });
      assert(restored?.metrics.area === 150 && restored.measuredOutputs[0].perMinute === 30, '刷新恢复丢失原图基线');
      await page.evaluate(record => window.__industrialPlannerAppHost.blueprintPreview.open({...record,parentFolderId:null}), ${JSON.stringify(unknown)});
      await page.getByRole('button', {name:'优化此蓝图',exact:true}).click();
      const choices = dialog.getByRole('combobox');
      await choices.first().waitFor();
      assert(await choices.count() === 2 && await identify.isDisabled(), '未知断头必须补全物品');
      await choices.nth(0).selectOption('item_iron_ore');
      assert(await identify.isDisabled(), '仍有未知出口时不能识别');
      await choices.nth(1).selectOption('item_iron_ore');
      await identify.click();
      await dialog.getByRole('alert').waitFor({timeout:60000});
      assert((await dialog.getByRole('alert').innerText()).includes('净产出'), '输入直接穿过的蓝图不应产生净产率');
      assert(await page.evaluate(() => window.__industrialPlannerAppHost.workspace.blueprintPlanner.queries.listTasks().length) === 1,
        '识别失败不应创建任务');
      await page.screenshot({path:${JSON.stringify(resolve(cli.directory, "rejected.png"))}});
      return {passed:true,screen,snapshot:await page.locator('body').ariaSnapshot()};
    }`);
    expect(result).toMatchObject({ passed: true });
  });
}
