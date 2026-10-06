import { expect, test, SCREEN_PROFILES } from "./harness/fixture";
import plant from "../blueprint-planner/fixtures/plant-preload.json" with { type: "json" };

// 三屏开发验证完成后独立编写：新任务默认值与已有任务配置分离，流程图允许页面原生滚动。
for (const profile of SCREEN_PROFILES) {
  test(`EDA 新任务默认值与流程图滚动 [${profile.name}]`, async ({ baseURL, browserSession }) => {
    test.setTimeout(120_000);
    const cli = await browserSession.openCli(profile);
    const result = await cli.runJson(`async page => {
      await page.addInitScript(() => {
        const settings = JSON.parse(localStorage.getItem('v3-user-settings-dialog') || '{}');
        settings.values = {...settings.values, 'other-experimental-features': true};
        localStorage.setItem('v3-user-settings-dialog', JSON.stringify(settings));
        localStorage.setItem('industrial-planner.eda.options', JSON.stringify({evaluationsPerRound:70000,concurrency:1}));
      });
      await page.goto(${JSON.stringify(baseURL)});
      await page.waitForFunction(() => window.__industrialPlannerAppHost?.workspace.blueprintPlanner != null);
      await page.evaluate(plan => {
        const controller = window.__industrialPlannerAppHost.blueprintPlannerDialog;
        controller.setEnabled(true); controller.open(plan);
      }, ${JSON.stringify(plant.request.plan)});
      const dialog = page.getByRole('dialog').filter({has:page.locator('#blueprint-planner-title')});
      const attempts = dialog.getByRole('spinbutton',{name:'单轮最大尝试次数（万次）'});
      const initial = await attempts.inputValue();
      const defaults = await page.evaluate(() => JSON.parse(JSON.stringify(window.__industrialPlannerAppHost.blueprintPlannerDialog.options)));
      await attempts.fill('7'); await attempts.blur();
      await dialog.getByRole('checkbox',{name:'CPU+GPU 并行计算'}).uncheck();
      await dialog.getByRole('combobox',{name:'存取线形态'}).selectOption('corner');
      await page.evaluate(async () => {
        const host = window.__industrialPlannerAppHost, controller = host.blueprintPlannerDialog;
        controller.updateItemPolicy({itemId:'item_plant_moss_3',output:'warehouse'});
        const planner = host.workspace.blueprintPlanner;
        const id = await planner.actions.importTask(planner.queries.exportDraft(controller.getRequest()));
        controller.selectTask(id, planner.queries.getLastRequest(id));
      });
      const retained = {attempts:await attempts.inputValue(),parallel:await dialog.getByRole('checkbox',{name:'CPU+GPU 并行计算'}).isChecked()};
      await dialog.getByRole('button',{name:'重新规划',exact:true}).click();
      const reset = await page.evaluate(() => JSON.parse(JSON.stringify(window.__industrialPlannerAppHost.blueprintPlannerDialog.options)));
      const resetInput = await attempts.inputValue();
      const canvas = dialog.locator('[class*="production-flow-canvas"]');
      const bounds = await canvas.evaluate(element => {
        let scroll = element.parentElement;
        while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
        if (!scroll) throw Error('缺少滚动容器');
        scroll.scrollTop = 0;
        return {bottom:scroll.getBoundingClientRect().bottom,touchAction:getComputedStyle(element).touchAction,
          height:element.getBoundingClientRect().height,parentHeight:element.parentElement.clientHeight};
      });
      const box = await canvas.boundingBox();
      const x = box.x + box.width * 0.65, y = Math.min(box.y + box.height,bounds.bottom) - 20;
      const end = Math.max(box.y + 20,y - 110);
      const surface = canvas.locator('[class*="production-flow-surface"]');
      const before = await surface.getAttribute('style');
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
        for (let step = 1; step <= 8; step++) {
          await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+(end-y)*step/8,id:1}]});
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await page.waitForTimeout(300);
      } finally { await cdp.detach(); }
      const scrollTop = await canvas.evaluate(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.scrollTop > 0) return parent.scrollTop;
        return 0;
      });
      const graphUnchanged = await surface.getAttribute('style') === before;
      await canvas.getByRole('button',{name:'+',exact:true}).click();
      const zoomChanged = await surface.getAttribute('style') !== before;
      await canvas.getByRole('button',{name:'重置布局',exact:true}).click();
      return {initial,defaults,retained,reset,resetInput,bounds,scrollTop,graphUnchanged,zoomChanged,
        resetView:await surface.getAttribute('style')===before};
    }`) as { initial: string; defaults: unknown; retained: { attempts: string; parallel: boolean }; reset: unknown;
      resetInput: string; bounds: { height: number; parentHeight: number; touchAction: string }; scrollTop: number;
      graphUnchanged: boolean; zoomChanged: boolean; resetView: boolean };
    expect(result.initial).toBe("500");
    expect(result.retained).toEqual({ attempts: "7", parallel: false });
    expect(result.reset).toEqual(result.defaults);
    expect(result.resetInput).toBe("500");
    expect(result.bounds.height).toBe(result.bounds.parentHeight);
    expect(result.bounds.touchAction).toBe("pan-y");
    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.graphUnchanged).toBe(true);
    expect(result.zoomChanged).toBe(true);
    expect(result.resetView).toBe(true);
  });
}
