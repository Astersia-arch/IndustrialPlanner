// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
const stages = ["eslint", "tsc", "test", "build", "e2e", "release", "blueprint"];
async function fixture(releaseExit: string | null) {
  const parent = resolve(".temp/.trash/check-runner-contract");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "summary-"));
  directories.push(directory);
  for (const stage of stages) {
    if (stage === "release" && releaseExit === null) continue;
    await writeFile(resolve(directory, `${stage}.exit`), stage === "release" ? releaseExit! : "0");
  }
  return spawnSync("bash", ["scripts/check/check-runner.sh", "summary", directory], { encoding: "utf8" });
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
describe("full-check 发布版测试汇总契约", () => {
  it("全部执行成功才返回成功", async () => {
    const result = await fixture("0");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("发布版测试 | npm run test:release | 通过");
  });
  it("发布版测试失败不能被其他成功阶段掩盖", async () => {
    expect((await fixture("1")).status).toBe(1);
  });
  it("漏跑发布版测试必须失败", async () => {
    expect((await fixture(null)).status).toBe(1);
  });
});
