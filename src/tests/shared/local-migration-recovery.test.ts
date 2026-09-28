import { readFromLocalStorageWithMigration } from "@/shared/storage/migration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLocalMigrationRecovery, MIGRATION_BACKUP_RETENTION_MS } from "@/shared/storage/local-migration-recovery";
import { openIndexedDbStores, readFromIndexedDb, saveToIndexedDb, trySaveToIndexedDb, waitForTransaction } from "@/shared/storage/browser-storage";
import { RECOVERY_DATABASE, RECOVERY_STORE, RECOVERY_GENERATION_KEY } from "@/shared/storage/storage-generation";
import { createFakeIndexedDbFactory } from "./fake-indexed-db";

let dispose: (() => void) | undefined;
const location = { databaseName: RECOVERY_DATABASE, storeName: "worddocument", key: "base-a" };
const oldDocument = { schemaVersion: 6, title: "原始产线", entities: { machine: { rotation: 90 } } };

beforeEach(() => {
  vi.stubGlobal("indexedDB", createFakeIndexedDbFactory());
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } });
});
afterEach(() => { dispose?.(); dispose = undefined; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function boot(schemaVersion: number, now = 100, buildId = `build-${schemaVersion}`) {
  dispose?.(); dispose = undefined;
  dispose = await prepareLocalMigrationRecovery({ schemaVersion, now, buildId, onInvalidated: () => {} });
}
async function writeRaw(storeName: string, key: string, value: unknown) {
  const database = await openIndexedDbStores({ databaseName: RECOVERY_DATABASE }, [storeName]);
  if (database === null) throw new Error("database missing");
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const done = waitForTransaction(transaction);
    transaction.objectStore(storeName).put(value, key);
    await done;
  } finally { database.close(); }
}

describe("local migration recovery", () => {
  it("restores the entire old dataset within ten days and discards post-upgrade edits and journals", async () => {
    await saveToIndexedDb(location, oldDocument);
    localStorage.setItem("v3-workbench", '{"panel":"old"}');
    localStorage.setItem("v3-sync-metadata", '{"contentHashes":{"world":"old-hash"},"remoteRevisions":{"world":3},"remoteEtags":{"world":"old-etag"}}');
    await boot(6);
    await boot(7, 200);
    await saveToIndexedDb(location, { schemaVersion: 7, title: "升级后修改" });
    await saveToIndexedDb({ ...location, key: "new-base" }, { schemaVersion: 7 });
    await saveToIndexedDb({ ...location, storeName: "cf-sync-upload-journal" }, { pending: true });
    localStorage.setItem("v3-workbench", '{"panel":"new"}');
    await boot(6, 300);
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
    expect(await readFromIndexedDb({ ...location, key: "new-base" })).toBeNull();
    expect(await readFromIndexedDb({ ...location, storeName: "cf-sync-upload-journal" })).toBeNull();
    expect(localStorage.getItem("v3-workbench")).toBe('{"panel":"old"}');
    expect(JSON.parse(localStorage.getItem("v3-sync-metadata")!)).toEqual({ contentHashes: { world: "old-hash" }, remoteRevisions: {}, remoteEtags: {} });
    await expect(boot(7, 400)).rejects.toThrow("已回滚");
    dispose = await prepareLocalMigrationRecovery({ schemaVersion: 7, buildId: "fixed-build", now: 500, onInvalidated: () => {}, verifyCurrentBuild: async () => true });
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
  });

  it("does not restore on a same-schema release rollback", async () => {
    await saveToIndexedDb(location, oldDocument);
    await boot(6);
    await saveToIndexedDb(location, { ...oldDocument, title: "最新编辑" });
    await boot(6, 200, "previous-build");
    expect(await readFromIndexedDb(location)).toMatchObject({ title: "最新编辑" });
  });

  it("rejects expired backups without modifying the upgraded document", async () => {
    await saveToIndexedDb(location, oldDocument);
    await boot(7);
    await saveToIndexedDb(location, { schemaVersion: 7 });
    await expect(boot(6, 100 + MIGRATION_BACKUP_RETENTION_MS)).rejects.toThrow("备份");
    expect(await readFromIndexedDb(location)).toEqual({ schemaVersion: 7 });
  });

  it("stops a stale tab before local writes and notifies it once", async () => {
    await saveToIndexedDb(location, oldDocument);
    const invalidated = vi.fn();
    dispose = await prepareLocalMigrationRecovery({ schemaVersion: 6, buildId: "a", onInvalidated: invalidated });
    localStorage.setItem(RECOVERY_GENERATION_KEY, "new-generation");
    window.dispatchEvent(new Event("storage"));
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(await trySaveToIndexedDb(location, { schemaVersion: 6, title: "stale" })).toBe(false);
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
  });

  it("retains damaged source bytes and refuses to pretend they are absent", async () => {
    await writeRaw("worddocument", "base-a", "{broken-json");
    await boot(6);
    await expect(readFromIndexedDb(location)).rejects.toThrow();
    await boot(7, 200);
    await saveToIndexedDb(location, { schemaVersion: 7 });
    await boot(6, 300);
    await expect(readFromIndexedDb(location, { deserialize: value => value })).resolves.toBe("{broken-json");
  });

  it("leaves original data intact when backup access fails, and allows a retry", async () => {
    await saveToIndexedDb(location, oldDocument);
    const fail = vi.spyOn(Storage.prototype, "key").mockImplementation(() => { throw new Error("storage denied"); });
    localStorage.setItem("v3-workbench", "{}");
    await expect(boot(7)).rejects.toThrow("storage denied");
    fail.mockRestore();
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
    await boot(7);
    await saveToIndexedDb(location, { schemaVersion: 7 });
    await boot(6, 200);
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
  });

  it("fails closed on an unknown recovery protocol", async () => {
    await saveToIndexedDb(location, oldDocument);
    await writeRaw(RECOVERY_STORE, "state", { formatVersion: 999, schemaVersion: 7 });
    await expect(boot(6)).rejects.toThrow("恢复记录无效");
    expect(await readFromIndexedDb(location)).toEqual(oldDocument);
  });
});

it("restores a compatible boundary across consecutive upgrades without reverting the account or connection", async () => {
  await saveToIndexedDb(location, oldDocument);
  await boot(6, 100);
  await boot(7, 200);
  await saveToIndexedDb(location, { schemaVersion: 7 });
  await boot(8, 300);
  await saveToIndexedDb(location, { schemaVersion: 8 });
  localStorage.setItem("v3-cloudflare-oauth-session", '{"account":"current-account"}');
  await saveToIndexedDb({ ...location, storeName: "sync-connection-settings" }, { url: "current-target" });
  await boot(6, 400);
  expect(await readFromIndexedDb(location)).toEqual(oldDocument);
  expect(localStorage.getItem("v3-cloudflare-oauth-session")).toBe('{"account":"current-account"}');
  expect(await readFromIndexedDb({ ...location, storeName: "sync-connection-settings" })).toEqual({ url: "current-target" });
});

it("refuses a damaged snapshot without replacing current data", async () => {
  await saveToIndexedDb(location, oldDocument);
  await boot(7, 100);
  await saveToIndexedDb(location, { schemaVersion: 7, title: "preserve" });
  const database = await openIndexedDbStores({ databaseName: RECOVERY_DATABASE }, [RECOVERY_STORE]);
  if (database === null) throw new Error("database missing");
  try {
    const transaction = database.transaction(RECOVERY_STORE, "readwrite");
    const completion = waitForTransaction(transaction);
    const store = transaction.objectStore(RECOVERY_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const value of request.result as { id?: string; checksum?: string }[]) {
        if (value.id?.startsWith("snapshot:")) store.put({ ...value, checksum: "corrupted" }, value.id);
      }
    };
    await completion;
  } finally { database.close(); }
  await expect(boot(6, 200)).rejects.toThrow("备份");
  expect(await readFromIndexedDb(location)).toEqual({ schemaVersion: 7, title: "preserve" });
});

it("does not replace an unsupported settings payload with empty defaults after safe startup", async () => {
  await boot(6);
  const original = '{"_v":99,"data":{"layout":"preserve"}}';
  localStorage.setItem("v3-future-settings", original);
  expect(() => readFromLocalStorageWithMigration("v3-future-settings", 1, [], undefined)).toThrow("cannot be migrated");
  expect(localStorage.getItem("v3-future-settings")).toBe(original);
});
