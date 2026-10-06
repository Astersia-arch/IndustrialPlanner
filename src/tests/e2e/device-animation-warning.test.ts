import { SCREEN_PROFILES } from "./harness/profiles";
import { expect, test, type Page } from "./harness/fixture";

// AI-REMOVED 2026-10-05:
// Reason: 三屏配置集中维护。Trigger: 基座迁移。Evidence: 与公共 profiles 重复。
// Replacement: harness/profiles.ts。Risk: Low。Human Review: Required
// Original code:
// const SCREEN_PROFILES = [
//   {
//     name: "mobile-landscape",
//     viewport: { width: 764, height: 345 },
//     deviceScaleFactor: 3.125,
//     hasTouch: true,
//     isMobile: true,
//     expectedDeviceClass: "mobile",
//     expectedScreenShape: "landscape",
//   },
//   {
//     name: "tablet-square",
//     viewport: { width: 711, height: 665 },
//     deviceScaleFactor: 3.125,
//     hasTouch: true,
//     isMobile: true,
//     expectedDeviceClass: "tablet",
//     expectedScreenShape: "square",
//   },
//   {
//     name: "desktop-landscape",
//     viewport: { width: 2552, height: 1315 },
//     deviceScaleFactor: 1,
//     hasTouch: true,
//     isMobile: false,
//     expectedDeviceClass: "desktop",
//     expectedScreenShape: "landscape",
//   },
// ] as const;

const WARNING_MESSAGE = "启用动画需要额外下载约 200 MB 的动画资源，并且运行时会消耗约 2 GB 到 4 GB 显存。不推荐电脑性能不够的管理员或者使用手机的管理员开启。关闭该选项不会清除已下载的动画资源，后续再打开时可以继续下载。";

// 开发期 playwright-cli 三档验证完成后独立编写；由单 worker 的正式 E2E 入口串行执行。
// AI-REMOVED 2026-10-05:
// Reason: 独立屏幕或主题用例不应因前项失败而跳过。
// Trigger: 用户授权统一 E2E 基座。
// Evidence: 当前用例重复管理相同运行资源。
// Replacement: playwright.config.ts 的 workers: 1
// Risk: Low。Human Review: Required
// Original code:
// test.describe.configure({ mode: "serial" });

for (const profile of SCREEN_PROFILES) {
  test(`设备动画只在确认后开启 [${profile.name}]`, async ({ browserSession: browser }, testInfo) => {
    test.setTimeout(90_000);
// AI-REMOVED 2026-10-05:
// Reason: 三屏配置集中维护。Trigger: 基座迁移。Evidence: 与公共 profiles 重复。
// Replacement: harness/profiles.ts。Risk: Low。Human Review: Required
// Original code:
//     const context = await browser.newContext({
//       viewport: profile.viewport,
//       deviceScaleFactor: profile.deviceScaleFactor,
//       hasTouch: profile.hasTouch,
//       isMobile: profile.isMobile,
//       locale: "zh-CN",
//     });
    const context = await browser.profile(profile);

    try {
      const page = await context.newPage();
      await installSettingsEnvironment(page, profile.isMobile);
      await page.goto("http://127.0.0.1:4174/");
      await expect(page.locator("canvas").first()).toBeVisible();
      await expect.poll(() => page.evaluate(() => (
        window.__industrialPlannerAppHost?.workspace.editor !== null
        && window.__industrialPlannerAppHost?.workspace.editor !== undefined
      ))).toBe(true);
      expect(await page.evaluate(() => window.__industrialPlannerAppHost?.state.screenProfile)).toMatchObject({
        viewportWidth: profile.width,
        viewportHeight: profile.height,
        devicePixelRatio: profile.dpr,
        deviceClass: profile.name,
        screenShape: profile.shape,
        hasTouch: true,
      });

      await page.getByRole("button", { name: "设置", exact: true }).click();
      const settingsDialog = page.getByRole("dialog", { name: "设置", exact: true });
      const animationSwitch = settingsDialog.locator('input[name="game-play-device-animations"]');
      const animationSwitchLabel = settingsDialog.locator(
        'label[for="setting-game-play-device-animations"]',
      );
      await animationSwitchLabel.scrollIntoViewIfNeeded();
      await expect(animationSwitch).not.toBeChecked();
      await testInfo.attach("before.yaml", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/yaml",
      });

      await animationSwitchLabel.click();
      const warningDialog = page.getByRole("dialog", { name: "启用设备动画", exact: true });
      await expect(warningDialog).toBeVisible();
      await expect(warningDialog.locator("p")).toHaveText(WARNING_MESSAGE);
      await expect(warningDialog.getByRole("button", { name: "取消", exact: true })).toBeVisible();
      await expect(warningDialog.getByRole("button", { name: "确定", exact: true })).toBeVisible();
      await expect(animationSwitch).not.toBeChecked();
      expect(await readDeviceAnimationSetting(page)).toBe(false);

      const warningBox = await warningDialog.boundingBox();
      expect(warningBox).not.toBeNull();
      if (warningBox === null) {
        throw new Error("设备动画警告窗口不可见");
      }
      expect(warningBox.x).toBeGreaterThanOrEqual(0);
      expect(warningBox.y).toBeGreaterThanOrEqual(0);
      expect(warningBox.x + warningBox.width).toBeLessThanOrEqual(profile.width);
      expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(profile.height);
      await page.screenshot({ path: testInfo.outputPath(`${profile.name}-warning.png`) });

      await warningDialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(warningDialog).toBeHidden();
      await expect(animationSwitch).not.toBeChecked();
      expect(await readDeviceAnimationSetting(page)).toBe(false);

      await animationSwitchLabel.click();
      await warningDialog.getByRole("button", { name: "确定", exact: true }).click();
      await expect(warningDialog).toBeHidden();
      await expect(animationSwitch).toBeChecked();
      expect(await readDeviceAnimationSetting(page)).toBe(true);

      await animationSwitchLabel.click();
      await expect(warningDialog).toBeHidden();
      await expect(animationSwitch).not.toBeChecked();
      expect(await readDeviceAnimationSetting(page)).toBe(false);
      await testInfo.attach("after.yaml", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/yaml",
      });
    } finally {
      await browser.closeContext(context);
    }
  });
}

async function installSettingsEnvironment(page: Page, isMobile: boolean): Promise<void> {
  await page.addInitScript((_mobile) => {
    localStorage.setItem("v3-user-settings-dialog", JSON.stringify({
      selectedGroupId: "display",
      values: {
        "other-experimental-features": false,
      },
    }));

// AI-REMOVED 2026-10-05:
// Reason: 三屏配置集中维护。Trigger: 基座迁移。Evidence: 与公共 profiles 重复。
// Replacement: harness/profiles.ts。Risk: Low。Human Review: Required
// Original code:
//     if (mobile) {
//       return;
//     }
//
//     Object.defineProperty(navigator, "maxTouchPoints", {
//       configurable: true,
//       get: () => 1,
//     });
//     const nativeMatchMedia = window.matchMedia.bind(window);
//     window.matchMedia = (query) => {
//       const result = nativeMatchMedia(query);
//       if (query !== "(pointer: coarse)" && query !== "(hover: none)") {
//         return result;
//       }
//
//       return new Proxy(result, {
//         get(target, property) {
//           if (property === "matches") {
//             return false;
//           }
//
//           const value = Reflect.get(target, property, target) as unknown;
//           return typeof value === "function" ? value.bind(target) : value;
//         },
//       });
//     };
  }, isMobile);
}

async function readDeviceAnimationSetting(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (
    window.__industrialPlannerAppHost?.state.settings.gamePlayDeviceAnimations
  ));
}
