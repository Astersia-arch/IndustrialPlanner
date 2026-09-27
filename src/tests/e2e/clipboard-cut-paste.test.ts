import { expect, test } from "./canvas-lock-audit";

const SCREEN_PROFILES = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125, isMobile: true },
  { name: "tablet", width: 711, height: 665, dpr: 3.125, isMobile: true },
  { name: "desktop", width: 2552, height: 1315, dpr: 1, isMobile: false },
] as const;

test.describe.configure({ mode: "serial" });

for (const profile of SCREEN_PROFILES) {
  test(`框选剪切并从其他画布工具粘贴 [${profile.name}]`, async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.dpr,
      hasTouch: profile.isMobile,
      isMobile: profile.isMobile,
      locale: "zh-CN",
    });

    try {
      if (!profile.isMobile) {
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
      expect(await page.evaluate(() => window.__industrialPlannerAppHost?.state.screenProfile)).toMatchObject({
        viewportWidth: profile.width,
        viewportHeight: profile.height,
        devicePixelRatio: profile.dpr,
        deviceClass: profile.name,
        hasTouch: true,
      });

      const entityId = await page.evaluate(() => {
        const host = window.__industrialPlannerAppHost!;
        const editor = host.workspace.editor!;
        const beforeIds = new Set(editor.document.getSnapshot().entityOrder);
        editor.actions.createSinglePlacementDraft("belt_straight_1x1", { x: 15, y: 15 });
        if (!editor.actions.applyPlacementDraft()) {
          throw new Error("无法准备剪切测试建筑");
        }
        const id = editor.document.getSnapshot().entityOrder.find((candidate) => !beforeIds.has(candidate));
        if (id === undefined) {
          throw new Error("测试建筑未写入文档");
        }
        editor.actions.focusOnEntity(id, { duration: 0 });
        editor.actions.addToCollection({ collectionType: "selection", entityId: id });
        return id;
      });

      await testInfo.attach("before.yaml", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/yaml",
      });
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+x");
      expect(await page.evaluate((id) => ({
        tool: window.__industrialPlannerAppHost!.state.activeTool,
        exists: window.__industrialPlannerAppHost!.workspace.editor!.document.getSnapshot().entities[id] !== undefined,
      }), entityId)).toEqual({ tool: "select", exists: true });

      await page.getByRole("button", { name: "批量选择", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__industrialPlannerAppHost!.state.activeTool)).toBe("marquee");
      await page.keyboard.press("Control+x");
      const cut = await page.evaluate((id) => {
        const host = window.__industrialPlannerAppHost!;
        const editor = host.workspace.editor!;
        return {
          tool: host.state.activeTool,
          exists: editor.document.getSnapshot().entities[id] !== undefined,
          previewCount: editor.state.collections.preview.length,
          blueprintId: host.internalState.runtime.blueprintPlacementRecord?.blueprintId ?? null,
          sourceIds: host.internalState.runtime.blueprintPlacementRecord?.entityOrder ?? [],
        };
      }, entityId);
      expect(cut.tool).toBe("blueprint-placement");
      expect(cut.exists).toBe(false);
      expect(cut.previewCount).toBe(1);
      expect(cut.sourceIds).toEqual([entityId]);

      await page.keyboard.press("Control+v");
      expect(await page.evaluate(() => window.__industrialPlannerAppHost!.internalState.runtime.blueprintPlacementRecord?.blueprintId))
        .toBe(cut.blueprintId);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => window.__industrialPlannerAppHost!.state.activeTool)).toBe("select");
      await page.keyboard.press("Control+v");
      await expect.poll(() => page.evaluate(() => window.__industrialPlannerAppHost!.state.activeTool))
        .toBe("blueprint-placement");
      expect(await page.evaluate(() => window.__industrialPlannerAppHost!.workspace.editor!.state.collections.preview.length))
        .toBe(1);
      await page.screenshot({ path: testInfo.outputPath("cut-paste.png") });
      await testInfo.attach("after.yaml", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/yaml",
      });
    } finally {
      await context.close();
    }
  });
}
