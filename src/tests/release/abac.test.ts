import type { Page } from "playwright";
import type { BlueprintDocument } from "@/domain/document/blueprint-document";
import type {} from "./browser-bridge";

/** CLI 入口只序列化这个函数；运行时依赖必须在函数内部声明。 */
export default async function abac(page: Page, options: { origin: string; output: string; schema: number }) {
  const { origin, output, schema } = options;
  const errors: string[] = [];
  const waits: { description: string; attempts: number; elapsedMs: number }[] = [];
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const equal = (actual: unknown, expected: unknown, message: string) => {
    check(JSON.stringify(actual) === JSON.stringify(expected), message);
  };
  page.on("pageerror", error => errors.push(String(error)));
  page.context().on("page", opened => opened.on("pageerror", error => errors.push(String(error))));
  await page.context().addInitScript(({ origin }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem("release-load-count", String(Number(sessionStorage.getItem("release-load-count") ?? 0) + 1));
    if (!localStorage.getItem("industrial-planner-pwa-preference")) {
      localStorage.setItem("industrial-planner-pwa-preference", JSON.stringify({
        offlineMode: "accepted", desktopInstallPromptDismissed: true, deviceAnimationsRequested: false,
      }));
    }
  }, { origin });
  async function switchBuild(label: string) {
    const response = await page.request.post(`${origin}/__switch?build=${label}`);
    check(response.ok(), `Switch ${label}: ${response.status()}`);
  }
  async function waitUntil(predicate: () => Promise<boolean>, description: string) {
    const started = Date.now();
    const deadline = started + 120_000;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      try {
        if (await predicate()) {
          waits.push({ description, attempts, elapsedMs: Date.now() - started });
          return;
        }
      } catch (error) {
        // PWA 首次接管及跨版本更新都可能在 readiness 检查期间导航。
        if (!String(error).includes("context was destroyed")) throw error;
      }
      await page.waitForTimeout(100);
    }
    throw Error(`Timed out waiting for ${description}`);
  }
  async function ready(target: Page, label: string) {
    // AI-CORRECTION 2026-09-28: 就绪条件必须在同一页面上下文内同时成立；
    // 分开等待会让旧页面的 bridge 与刷新中新页面的入口检查拼成假就绪。
    // AI-CORRECTION 2026-09-28: 当前 CLI 的 waitForFunction 将 Promise 判为真值；
    // 使用 evaluate 等待异步结果后显式轮询，不把 Promise 本身视为就绪。
    await waitUntil(() => target.evaluate(async label => {
      const bridge = window.__releaseTest;
      const controller = navigator.serviceWorker.controller;
      if (bridge?.label !== label || !controller || document.readyState !== "complete") return false;
      const registration = await navigator.serviceWorker.getRegistration();
      // waiting 是产品允许的“等待用户更新”状态，不等于当前页面未就绪。
      if (!registration || registration.active !== controller || controller.state !== "activated") return false;
      const response = await fetch(location.href, { cache: "no-store", headers: { "X-IndustrialPlanner-Network-Only": "1" } });
      const html = new DOMParser().parseFromString(await response.text(), "text/html");
      const expected = html.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
      const actual = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
      if (!expected || expected !== actual || !await bridge.ready()) return false;
      return window.__releaseTest === bridge && navigator.serviceWorker.controller === controller;
    }, label), `ready ${label}`);
  }
  async function evidence(name: string, data: unknown) {
    const response = await page.request.post(`${origin}/__evidence/${name}`, { data });
    check(response.ok(), `Cannot persist evidence: ${name}`);
  }
  async function capture(stage: string) {
    const state = await page.evaluate(async () => {
      const document = await window.__releaseTest.document();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("v3-industrial-planner");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores: Record<string, { key: IDBValidKey; value: unknown }[]> = {};
      try {
        for (const name of Array.from(db.objectStoreNames)) {
          stores[name] = await new Promise((resolve, reject) => {
            const entries: { key: IDBValidKey; value: unknown }[] = [];
            const request = db.transaction(name).objectStore(name).openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (cursor) { entries.push({ key: cursor.key, value: cursor.value }); cursor.continue(); }
              else resolve(entries);
            };
          });
        }
      } finally { db.close(); }
      return {
        label: window.__releaseTest.label, schema: window.__releaseTest.schema, document, stores,
        local: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith("v3-")).map(key => [key, localStorage.getItem(key)])),
        controlled: Boolean(navigator.serviceWorker.controller), caches: await caches.keys(),
      };
    });
    await evidence(stage, state);
    await page.evaluate(() => window.__releaseTest.focus());
    await page.screenshot({ path: `${output}/${stage}.png` });
    return state;
  }
  async function simulate(stage: string) {
    const result = await page.evaluate(() => window.__releaseTest.simulate());
    await evidence(`${stage}-simulation`, result);
    check(result.status === "completed", `${stage}: simulation not completed`);
    return result;
  }
  let second: Page | undefined;
  try {
    await switchBuild("A");
    await page.goto(origin);
    // 先等待首次控制器切换引发的页面刷新，再进行造数。
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null && Number(sessionStorage.getItem("release-load-count")) >= 2, undefined, { timeout: 120_000 });
    const fixture = await (await page.request.get(`${origin}/__fixture.json`)).json() as BlueprintDocument;
    await ready(page, "A");
    await page.evaluate(fixture => window.__releaseTest.seed(fixture), fixture);
    await waitUntil(() => page.evaluate(() => window.__releaseTest.modulePersisted("Release A")), "persist A module");
    const initial = await capture("A");
    check(initial.schema === schema && initial.document.schemaVersion === schema, "A schema");
    const simulationA = await simulate("A");
    check(simulationA.probes[0]!.amount > 0, "A fixture must transport items");
    second = await page.context().newPage();
    await second.goto(origin);
    await ready(second, "A");

    await switchBuild("B");
    await page.reload();
    await ready(page, "B");
    await ready(second, "B");
    const upgraded = await capture("B");
    check(upgraded.document.schemaVersion === schema + 1 && upgraded.schema === schema + 1, "B schema");
    check(upgraded.document.entities.belt!.rotation === (initial.document.entities.belt!.rotation + 180) % 360, "B fault not applied");
    const simulationB = await simulate("B");
    check(simulationB.probes[0]!.amount === 0, "B fault must stop transport");
    type Snapshot = { id: string; schemaVersion: number; createdAt: number; expiresAt: number;
      stores: { name: string; entries: { key: IDBValidKey; value: unknown }[] }[]; local: Record<string, string> };
    const backup = upgraded.stores["local-migration-recovery"]!.map(entry => entry.value as Snapshot)
      .filter(value => value.id?.startsWith("snapshot:") && value.schemaVersion === schema)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    check(backup, "Missing pre-migration snapshot");
    check(backup!.expiresAt - backup!.createdAt === 10 * 86_400_000, "Snapshot retention must be ten days");
    const rawWorld = backup!.stores.find(store => store.name === "worddocument")!.entries
      .find(entry => entry.key === initial.document.documentKey)!.value as string;
    const oldWorld = JSON.parse(rawWorld) as typeof initial.document;
    equal(oldWorld.entities, initial.document.entities, "Backup contains migrated data");
    await page.evaluate(() => window.__releaseTest.edit());
    await waitUntil(() => page.evaluate(() => window.__releaseTest.modulePersisted("Release B")), "persist B module");
    const edited = await capture("B-edited");
    check(edited.document.entities["source-storage"]!.config["storageSlotGroups[0].slots[0].initialCount"] === 99, "B edit not persisted");
    check(edited.stores.blueprints!.some(entry => entry.key === "blueprint:release-new"), "B creation not persisted");
    check(!edited.stores.blueprints!.some(entry => entry.key === "blueprint:release-delete"), "B deletion not persisted");

    let refreshes = 0;
    second.on("framenavigated", frame => { if (frame === second!.mainFrame()) refreshes++; });
    await switchBuild("A");
    await page.reload();
    await ready(page, "A");
    await ready(second, "A");
    const restored = await capture("rollback-A");
    check(refreshes > 0, "Other tab did not refresh");
    check(restored.document.schemaVersion === schema, "Rollback schema");
    for (const key of ["entities", "entityOrder", "slotLinks", "regions"] as const) equal(restored.document[key], oldWorld[key], `World restore: ${key}`);
    for (const name of ["blueprints", "editorhistory"]) {
      equal(restored.stores[name], backup!.stores.find(store => store.name === name)!.entries, `Raw restore: ${name}`);
    }
    equal(restored.local["v3-release-sentinel"], backup!.local["v3-release-sentinel"], "Local original lost");
    check(!("v3-release-new" in restored.local), "New local record survived rollback");
    check(await page.evaluate(() => window.__releaseTest.modulePersisted("Release A")), "Module data not restored");
    const simulationRestored = await simulate("rollback-A");
    equal(simulationRestored.probes, simulationA.probes, "Rollback transport differs");

    await switchBuild("C");
    await page.reload();
    await ready(page, "C");
    await ready(second, "C");
    const fixed = await capture("C");
    check(fixed.document.schemaVersion === schema + 1, "C schema");
    equal(fixed.document.entities, initial.document.entities, "C reused broken B data");
    check(!fixed.stores.blueprints!.some(entry => entry.key === "blueprint:release-new"), "C retained B new blueprint");
    const simulationC = await simulate("C");
    equal(simulationC.probes, simulationA.probes, "C transport differs");
    check([initial, upgraded, restored, fixed].every(state => state.controlled), "Uncontrolled PWA stage");
    equal(errors, [], "Uncaught page errors");
    const result = {
      passed: true, stages: ["A", "B", "A", "C"], baselineSchema: schema,
      amounts: [simulationA, simulationB, simulationRestored, simulationC].map(report => report.probes[0]!.amount),
      otherTabRefreshed: refreshes > 0, backupRetentionDays: 10, errors, waits,
    };
    await evidence("result", result);
    return result;
  } catch (error) {
    await evidence("failure", { error: String(error), errors, waits });
    await page.screenshot({ path: `${output}/failure.png` }).catch(() => undefined);
    throw error;
  } finally {
    await second?.close();
  }
}
