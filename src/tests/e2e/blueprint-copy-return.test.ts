import { expect, test, type Page } from "./canvas-lock-audit";

const profiles = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125 },
  { name: "tablet", width: 711, height: 665, dpr: 3.125 },
  { name: "desktop", width: 2552, height: 1315, dpr: 1 },
] as const;

// 开发期 playwright-cli 三屏验证后独立编写；正式执行仍需单 worker 串行运行。
test.describe.configure({ mode: "serial" });

for (const profile of profiles) {
  test(`复制连续放置后返回原选区，剪切粘贴不继承返回状态 [${profile.name}]`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.dpr,
      hasTouch: profile.name !== "desktop",
      isMobile: profile.name !== "desktop",
    });
    try {
      if (profile.name === "desktop") {
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 1 });
        });
      }
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("canvas").first()).toBeVisible();
      await expect.poll(() => page.evaluate(() =>
        window.__industrialPlannerAppHost?.workspace.editor?.state.viewport.clientRect.width ?? 0,
      )).toBeGreaterThan(0);
      const ids = await page.evaluate(() => {
        const editor = window.__industrialPlannerAppHost!.workspace.editor!;
        const existing = new Set(editor.document.getSnapshot().entityOrder);
        for (const x of [15, 17]) {
          editor.actions.createSinglePlacementDraft("belt_straight_1x1", { x, y: 15 });
          if (!editor.actions.applyPlacementDraft()) throw new Error("准备复制放置场景失败");
        }
        const result = editor.document.getSnapshot().entityOrder.filter((id) => !existing.has(id));
        editor.actions.focusOnEntity(result[0]!, { duration: 100 });
        for (const entityId of result) {
          editor.actions.addToCollection({ collectionType: "selection", entityId });
        }
        return result;
      });
      await expect.poll(() => page.evaluate(() =>
        window.__industrialPlannerAppHost!.workspace.editor!.state.viewport.center.x,
      )).toBe(15.5);
      await page.evaluate(() => window.__industrialPlannerAppHost!.workspace.editor!.actions.zoom(-12));
      await page.getByRole("button", { name: "批量选择", exact: true }).click();
      await testInfo.attach("before.yaml", { body: await page.locator("body").ariaSnapshot(), contentType: "text/yaml" });

      await page.keyboard.press("Control+c");
      expect(await readSelection(page)).toMatchObject({ tool: "blueprint-placement", ids, continuous: true });
      await page.keyboard.press("Escape");
      expect(await readSelection(page)).toMatchObject({ tool: "marquee", ids, preview: 0 });

      await page.keyboard.press("Control+c");
      const beforeCount = (await readSelection(page)).count;
      for (const x of [22, 27]) {
        await placeAt(page, x, 15);
      }
      expect(await readSelection(page)).toMatchObject({
        tool: "blueprint-placement", ids, count: beforeCount + 4, preview: 2,
      });
      const canvas = await page.locator("canvas").first().boundingBox();
      if (canvas === null) throw new Error("画布不可见");
      await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { button: "right" });
      expect(await readSelection(page)).toMatchObject({ tool: "marquee", ids, preview: 0 });
      await page.screenshot({ path: testInfo.outputPath("copy-selection-return.png") });
      await testInfo.attach("after.yaml", { body: await page.locator("body").ariaSnapshot(), contentType: "text/yaml" });

      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await page.keyboard.press("Escape");
      expect(await readSelection(page)).toMatchObject({ tool: "select", ids: [], preview: 0 });
      await page.keyboard.press("x");
      await page.evaluate((selectedIds) => {
        const editor = window.__industrialPlannerAppHost!.workspace.editor!;
        for (const entityId of selectedIds) editor.actions.addToCollection({ collectionType: "selection", entityId });
      }, ids);
      await page.keyboard.press("Control+x");
      expect(await readSelection(page)).toMatchObject({ tool: "blueprint-placement", ids: [], count: beforeCount + 2 });
      await page.keyboard.press("Escape");
      expect(await readSelection(page)).toMatchObject({ tool: "select", ids: [], preview: 0 });
      await page.keyboard.press("x");
      expect((await readSelection(page)).tool).toBe("marquee");
      await page.keyboard.press("x");
      expect((await readSelection(page)).tool).toBe("select");
    } finally {
      await context.close();
    }
  });
}

async function readSelection(page: Page) {
  return page.evaluate(() => {
    const host = window.__industrialPlannerAppHost!;
    const editor = host.workspace.editor!;
    return {
      tool: host.state.activeTool,
      ids: [...editor.state.collections.selection],
      preview: editor.state.collections.preview.length,
      count: editor.document.getSnapshot().entityOrder.length,
      continuous: host.internalState.runtime.blueprintPlacementContinuous,
    };
  });
}

async function placeAt(page: Page, x: number, y: number) {
  const point = await page.evaluate((gridPoint) => {
    const rect = window.__industrialPlannerAppHost!.workspace.editor!.queries.findClientRectForGridCell(gridPoint);
    if (rect === null) throw new Error("无法定位放置坐标");
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, { x, y });
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
}
