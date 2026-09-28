import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("background storage failures", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("reports synchronous and asynchronous failures without unhandled rejections", async () => {
    const storage = await import("@/shared/storage/storage-failure");
    const notify = vi.fn();
    const unsubscribe = storage.subscribeToStorageFailures(notify);
    expect(storage.hasStorageFailure()).toBe(false);
    storage.runStorageEffect("settings", () => { throw new Error("quota"); });
    storage.runStorageEffect("document", () => Promise.reject(new Error("unavailable")));
    await Promise.resolve();
    expect(storage.hasStorageFailure()).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("isolates a failed notice subscriber and keeps the warning after unrelated successful saves", async () => {
    const storage = await import("@/shared/storage/storage-failure");
    const failed = storage.subscribeToStorageFailures(() => { throw new Error("view failed"); });
    const notify = vi.fn();
    const unsubscribe = storage.subscribeToStorageFailures(notify);
    storage.reportStorageFailure("history", new Error("unavailable"));
    storage.runStorageEffect("settings", () => Promise.resolve());
    await Promise.resolve();
    expect(notify).toHaveBeenCalledOnce();
    expect(storage.hasStorageFailure()).toBe(true);
    failed(); unsubscribe();
  });

  it("keeps command failures observable and preserves previously saved data", async () => {
    const { saveToLocalStorage } = await import("@/shared/storage/browser-storage");
    const storage = await import("@/shared/storage/storage-failure");
    const key = "storage-failure-test";
    localStorage.setItem(key, '{"title":"original"}');
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    try {
      expect(() => saveToLocalStorage(key, { title: "replacement" })).toThrow("Failed to save");
      expect(localStorage.getItem(key)).toBe('{"title":"original"}');
      expect(storage.hasStorageFailure()).toBe(true);
    } finally {
      localStorage.removeItem(key);
    }
  });
});
