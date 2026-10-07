import type { Page } from "playwright";
import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type {} from "../e2e/harness/browser-bridge";

export interface DockWidthMeasurement {
  label: string;
  dockWidth: number;
  bodyWidth: number;
  panelWidth: number;
  containers: { name: string; width: number }[];
  escapedContent: string[];
  clippedWarehouseCells: string[];
}

/** 由 CLI 在真实页面中执行；宽度来自浏览器排版，不 mock DOM 尺寸。 */
export async function runLeftDockWidthScenario(page: Page, options: {
  url: string;
  locale: "zh-CN" | "en-US";
  fixture: BlueprintDocument;
  screenshotPath: string;
}): Promise<{ screen: unknown; measurements: DockWidthMeasurement[]; snapshot: string }> {
  page.setDefaultTimeout(10_000);
  await page.context().addInitScript(locale => {
    localStorage.setItem("v3-app-settings", JSON.stringify({ locale, debugMode: true, showRegionAnnotations: true }));
    // 区域标注属于实验功能；关闭总开关时设置控制器会将其恢复为默认关闭。
    localStorage.setItem("v3-user-settings-dialog", JSON.stringify({ values: { "other-experimental-features": true } }));
  }, options.locale);
  await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => {
    const ready = window.__test__?.readiness();
    return ready?.assembled && ready.canvasAttached && ready.viewportValid;
  }, undefined, { timeout: 30_000 });
  await page.evaluate(fixture => window.__test__!.loadBlueprint(fixture), options.fixture);
  await page.evaluate(() => document.fonts.ready);
  const screen = await page.evaluate(() => window.__test__!.getAppState().screen);
  const panels = ["placement", "region", "blueprint", "history", "base", "simulation"] as const;
  const labels = await page.evaluate(ids => Object.fromEntries(ids.map(id => [
    id, window.__industrialPlannerAppHost!.actions.translate(`workbench.leftRail.${id}`),
  ])), panels);
  const rail = page.locator('aside[class*="left-toolbar"]');
  const measurements: DockWidthMeasurement[] = [];
  const activate = async (id: typeof panels[number]) => {
    const button = rail.getByRole("button", { name: labels[id], exact: true });
    if (await button.getAttribute("aria-pressed") !== "true") await button.click();
    await page.locator(`[data-panel-id="${id}"]:not([hidden])`).waitFor();
  };
  const measure = async (label: string) => {
    // 等待 React 的提交与浏览器排版，测量与截图使用同一份真实 DOM。
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    measurements.push(await page.evaluate(label => {
      const panel = document.querySelector<HTMLElement>('[data-panel-id]:not([hidden])')!;
      const body = panel.parentElement!, dock = body.parentElement!.parentElement!;
      const dockRect = dock.getBoundingClientRect();
      const candidates = [body, panel, ...panel.querySelectorAll<HTMLElement>("div,section,article,label,ul,li,button,input,textarea,p,strong,dt,dd,span")];
      const containers: DockWidthMeasurement["containers"] = [];
      const escapedContent: string[] = [];
      for (const element of candidates) {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.position === "fixed" || style.position === "absolute") continue;
        const name = `${element.tagName}.${element.className}`;
        containers.push({ name, width: rect.width });
        // 蓝图页签、路径和 JSON 文本有明确的内部滚动；它们仍检查宽度，但不把滚动内容当作侧栏溢出。
        let scrollsInternally = false;
        for (let parent = element.parentElement; parent && parent !== dock; parent = parent.parentElement) {
          if (["auto", "scroll"].includes(getComputedStyle(parent).overflowX)) { scrollsInternally = true; break; }
        }
        if (!scrollsInternally && rect.right > dockRect.left + dock.clientWidth + 1) escapedContent.push(name);
      }
      const clippedWarehouseCells: string[] = [];
      for (const row of panel.querySelectorAll<HTMLElement>('[class*="warehouse-stats-row"]')) {
        const rowRect = row.getBoundingClientRect();
        for (const cell of row.querySelectorAll<HTMLElement>(":scope > span")) {
          const rect = cell.getBoundingClientRect();
          if (rect.right > rowRect.right + 1 || rect.left < rowRect.left - 1 || cell.scrollWidth > cell.clientWidth + 1) {
            clippedWarehouseCells.push(cell.textContent ?? "");
          }
        }
      }
      return { label, dockWidth: dock.clientWidth, bodyWidth: body.getBoundingClientRect().width,
        panelWidth: panel.getBoundingClientRect().width, containers, escapedContent, clippedWarehouseCells };
    }, label));
  };

  for (const panel of panels) {
    await activate(panel);
    await measure(`${options.locale}-${panel}`);
  }
  await activate("base");
  const copy = await page.evaluate(() => {
    const t = window.__industrialPlannerAppHost!.actions.translate;
    return { infinite: t("workbench.power.infiniteSwitch"), clear: t("workbench.power.clearOverride") };
  });
  const powerSwitch = page.locator("label").filter({ hasText: copy.infinite }).getByRole("switch");
  if (await powerSwitch.getAttribute("aria-checked") !== "true") await powerSwitch.click();
  await measure("power-infinite");
  await powerSwitch.click();
  await page.locator('[class*="power-override-input"]').waitFor();
  await measure("power-real");
  const override = page.locator('[class*="power-override-input"]');
  await override.fill("12345.678901234567");
  await override.press("Enter");
  await page.getByRole("button", { name: copy.clear, exact: true }).waitFor();
  await measure("power-override-with-clear");
  await page.getByRole("button", { name: copy.clear, exact: true }).click();
  await measure("power-override-cleared");
  await powerSwitch.click();
  await measure("power-infinite-restored");

  const simulationControl = page.locator('[data-ui-button-id="top-bar-simulation-control"]');
  await simulationControl.click();
  await page.locator('[class*="warehouse-stats-row"]:not([class*="warehouse-stats-row-head"])').first().waitFor();
  await simulationControl.click();
  await measure("warehouse-running");
  // 展示压力样本只替换文字，不替换组件、样式、主机或测量方法。
  await page.evaluate(() => {
    document.querySelector('[class*="power-bar-values"]')!.textContent = "12345.678901234567 kW / 98765.432109876543 kW";
    for (const cell of document.querySelectorAll('[class*="warehouse-stats-number"]')) cell.textContent = "123456789012.34";
  });
  await measure("power-and-warehouse-long-number-text");
  await page.locator('[data-ui-button-id="top-bar-simulation-stop"]').click();

  await activate("region");
  await page.locator('[data-region-id="width-region"] button').first().click();
  await page.locator("[data-region-details]").waitFor();
  await measure("region-long-name-and-url");
  const details = page.locator("[data-region-details]");
  await details.getByRole("button", { name: options.locale === "zh-CN" ? "选择包含的设备" : "Select Contained Devices", exact: true }).click();
  // 真实“选择包含的设备”交互使反查区出现，检验其中的长名称按钮。
  await page.locator('[data-region-panel] section').filter({ hasText: options.locale === "zh-CN" ? "当前所选设备所在区域" : "Regions for Selected Devices" }).waitFor();
  await measure("region-reverse-lookup-long-name");
  // 选择设备会自动打开属性窗口；通过真实关闭事件恢复左栏的可操作性。
  const inspector = page.locator('[data-dialog-key="inspector"]');
  if (await inspector.isVisible()) {
    await inspector.getByRole("button", { name: options.locale === "zh-CN" ? "关闭" : "Close", exact: true }).click();
  }
  await details.getByRole("button", { name: options.locale === "zh-CN" ? "编辑形状与属性" : "Edit Shape & Properties", exact: true }).click();
  await page.locator("[data-region-editor]").waitFor();
  await measure("region-editor-long-inputs");
  await page.screenshot({ path: options.screenshotPath });
  return { screen, measurements, snapshot: await page.locator("body").ariaSnapshot() };
}
