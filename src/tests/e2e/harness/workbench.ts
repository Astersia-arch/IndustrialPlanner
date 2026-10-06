import { expect, type Page } from "playwright/test";
import type {} from "./browser-bridge";
import type { TestScreenProfile } from "./profiles";

export async function waitForAppReady(page: Page, profile?: TestScreenProfile): Promise<void> {
  let last: unknown;
  await expect.poll(async () => {
    last = await page.evaluate(() => window.__test__?.readiness() ?? null);
    const value = last as ReturnType<NonNullable<Window["__test__"]>["readiness"]> | null;
    return Boolean(value?.assembled && value.canvasAttached && value.viewportValid);
  }, { timeout: 30_000, message: "等待主机装配、Canvas 挂载和有效视口" }).toBe(true).catch(error => {
    throw new Error(`应用未就绪，最后状态：${JSON.stringify(last)}`, { cause: error });
  });
  if (profile) expect(await page.evaluate(() => window.__test__!.getAppState().screen)).toMatchObject({
    viewportWidth: profile.width, viewportHeight: profile.height,
    devicePixelRatio: profile.dpr, deviceClass: profile.name, screenShape: profile.shape, hasTouch: true,
  });
}

export async function closeInspector(page: Page): Promise<void> {
  const dialog = page.locator('[data-dialog-key="inspector"]');
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}

export async function chooseSettingsGroup(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const tree = dialog.getByRole("tree");
  if (await tree.isVisible()) await tree.getByRole("treeitem", { name, exact: true }).click();
  else await dialog.getByRole("button", { name, exact: true }).click();
}

export async function clickEntity(page: Page, id: string): Promise<void> {
  await page.evaluate(entityId => window.__test__!.focusEntity(entityId), id);
  const point = await page.evaluate(entityId => window.__test__!.entityPoint(entityId), id);
  await expectCanvasHit(page, point);
  await page.mouse.click(point.x, point.y);
}

/** 原生坐标操作没有 locator 的遮挡检查，显式验证命中画布后才发送事件。 */
export async function expectCanvasHit(page: Page, point: { x: number; y: number }): Promise<void> {
  await expect.poll(() => page.evaluate(position => {
    const hit = document.elementFromPoint(position.x, position.y);
    return hit instanceof HTMLCanvasElement;
  }, point), { timeout: 5000, message: `画布坐标不可操作或被遮挡：${JSON.stringify(point)}` }).toBe(true);
}
