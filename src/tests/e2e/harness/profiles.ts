import type { BrowserContext, BrowserContextOptions } from "playwright/test";

export const SCREEN_PROFILES = [
  { name: "mobile", width: 764, height: 345, dpr: 3.125, isMobile: true, shape: "landscape" },
  { name: "tablet", width: 711, height: 665, dpr: 3.125, isMobile: true, shape: "square" },
  { name: "desktop", width: 2552, height: 1315, dpr: 1, isMobile: false, shape: "landscape" },
] as const;
export type TestScreenProfile = typeof SCREEN_PROFILES[number];

export function contextOptions(profile: TestScreenProfile): BrowserContextOptions {
  return { viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
    hasTouch: true, isMobile: profile.isMobile, locale: "zh-CN" };
}

/** 桌面可触控，但主指针仍然精细；不修改应用自身的环境判断。 */
export async function installDesktopPointer(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 1 });
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const media = original(query);
      if (query !== "(pointer: coarse)" && query !== "(hover: none)") return media;
      return new Proxy(media, { get(target, key) {
        if (key === "matches") return false;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
  });
}
