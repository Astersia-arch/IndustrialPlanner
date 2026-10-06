import { mkdir, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireBrowserLease, assertBrowserIdle } from "../browser-test/runtime.mjs";

export default async function setup(config) {
  if (config.workers !== 1 || config.fullyParallel || config.shard) {
    throw new Error("E2E 必须使用单 worker，禁止并行与分片");
  }
  const release = await acquireBrowserLease("e2e");
  const directory = config.projects[0].outputDir;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "run.json"), JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid,
      workers: config.workers, fullyParallel: config.fullyParallel, node: process.version }, null, 2));
  } catch (error) { await release(); throw error; }
  // AI-REMOVED 2026-10-05:
  // Reason: 在获取锁前验证配置，避免配置失败留下锁。
  // Trigger: 基座串行与异常清理要求。Evidence: config.shard 也会启动分片。
  // Replacement: 本函数入口验证。Risk: Low。Human Review: Required
  // Original code:
  // if (config.workers !== 1 || config.fullyParallel) {
  //   await release();
  //   throw new Error("E2E 必须使用单 worker，禁止并行与分片");
  // }
  return async () => {
    try {
      await assertBrowserIdle();
      try { await access(resolve(directory, "cleanup-failed")); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      throw new Error("某轮资源清理失败，请查看 cleanup.json");
    } finally { await release(); }
  };
}
