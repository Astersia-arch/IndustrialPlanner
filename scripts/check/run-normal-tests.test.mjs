import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runNormalTests } from "./run-normal-tests.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const file = resolve(root, "src/tests/shared/example.test.ts");
const timeout = "Error: Test timed out in 30000ms.\nIf this is a long-running test";

function assertion(name, status, messages = []) {
  return { fullName: `suite ${name}`, status, failureMessages: messages };
}

function report(assertions, success) {
  return {
    success,
    numFailedTests: assertions.filter(entry => entry.status === "failed").length,
    testResults: [{ name: file, status: success ? "passed" : "failed", message: "", assertionResults: assertions }],
  };
}

async function fixture(t, attempts) {
  const parent = resolve(root, ".temp/.trash/normal-test-runner");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "case-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const run = async (_directory, label, args) => {
    calls.push({ label, args });
    const attempt = attempts[calls.length - 1];
    assert.ok(attempt, `Unexpected Vitest invocation: ${label}`);
    await writeFile(resolve(directory, `${label}.json`), JSON.stringify(attempt.report));
    await writeFile(resolve(directory, `${label}.metadata.json`), JSON.stringify({
      reason: attempt.reason ?? (attempt.report.success ? "passed" : "failed"),
      requestedFiles: attempt.requestedFiles ?? [file],
      completedFiles: attempt.completedFiles ?? [file],
      unhandledErrors: attempt.unhandledErrors ?? [],
    }));
    return { code: attempt.code, signal: null };
  };
  return { directory, calls, run };
}

test("完整首轮后仅串行复跑超时用例，并保留其他失败", async t => {
  const first = report([
    assertion("one", "failed", [timeout]),
    assertion("two", "failed", [timeout]),
    assertion("assertion", "failed", ["AssertionError: expected 1 to be 2"]),
  ], false);
  const context = await fixture(t, [
    { code: 1, report: first },
    { code: 0, report: report([assertion("one", "passed")], true) },
    { code: 1, report: report([assertion("two", "failed", [timeout])], false) },
  ]);
  const result = await runNormalTests(context.directory, context.run);
  assert.deepEqual(context.calls.map(call => call.label), ["initial", "retry-001", "retry-002"]);
  assert.deepEqual(result.retries.map(retry => retry.status), ["passed", "timed-out"]);
  assert.equal(result.otherFailures.length, 1);
  assert.equal(result.passed, false);
  for (const call of context.calls.slice(1)) {
    assert.ok(call.args.includes("--maxWorkers=1"));
    assert.ok(call.args.includes("--maxConcurrency=1"));
    assert.ok(call.args.includes("--no-file-parallelism"));
    assert.ok(call.args.some(arg => arg.startsWith("--testNamePattern=^suite ")));
  }
  assert.deepEqual(JSON.parse(await readFile(resolve(context.directory, "summary.json"), "utf8")), result);
});

test("首轮仅超时且复跑通过时，最终通过并保留首轮证据", async t => {
  const context = await fixture(t, [
    { code: 1, report: report([assertion("one", "failed", [timeout])], false) },
    { code: 0, report: report([assertion("one", "passed")], true) },
  ]);
  const result = await runNormalTests(context.directory, context.run);
  assert.equal(result.passed, true);
  assert.equal(result.initialExitCode, 1);
  assert.deepEqual(result.retries.map(retry => retry.status), ["passed"]);
});

test("未归属错误阻止超时复跑掩盖 worker 故障", async t => {
  const context = await fixture(t, [
    {
      code: 1,
      report: report([assertion("one", "failed", [timeout])], false),
      unhandledErrors: [{ message: "Timeout waiting for worker to respond" }],
    },
    { code: 0, report: report([assertion("one", "passed")], true) },
  ]);
  const result = await runNormalTests(context.directory, context.run);
  assert.equal(result.passed, false);
  assert.match(result.otherFailures[0], /Timeout waiting for worker/u);
});

test("worker 启动超时导致文件未完成时，整文件逐个单 worker 复跑", async t => {
  const completedFile = resolve(root, "src/tests/shared/completed.test.ts");
  const initial = report([], true);
  initial.testResults[0].name = completedFile;
  const context = await fixture(t, [
    {
      code: 1,
      report: initial,
      requestedFiles: [file, completedFile],
      completedFiles: [completedFile],
      unhandledErrors: [{
        message: `[vitest-pool]: Failed to start forks worker for test files ${file}.`,
        cause: "[vitest-pool-runner]: Timeout waiting for worker to respond",
      }],
    },
    { code: 0, report: report([assertion("one", "passed")], true) },
  ]);
  const result = await runNormalTests(context.directory, context.run);
  assert.equal(result.passed, true);
  assert.deepEqual(context.calls.map(call => call.label), ["initial", "file-retry-001"]);
  assert.deepEqual(context.calls[1].args, [file, "--maxWorkers=1", "--maxConcurrency=1", "--no-file-parallelism"]);
  assert.deepEqual(result.fileRetries.map(retry => retry.status), ["passed"]);
});

test("worker 启动超时复跑后仍超时，最终标记超时", async t => {
  const context = await fixture(t, [
    {
      code: 1,
      report: report([], true),
      requestedFiles: [file],
      completedFiles: [],
      unhandledErrors: [{ message: "[vitest-pool]: Timeout starting forks runner." }],
    },
    {
      code: 1,
      report: { ...report([], true), testResults: [] },
      requestedFiles: [file],
      completedFiles: [],
      unhandledErrors: [{ message: "[vitest-pool]: Timeout starting forks runner." }],
    },
  ]);
  const result = await runNormalTests(context.directory, context.run);
  assert.equal(result.passed, false);
  assert.deepEqual(result.fileRetries.map(retry => retry.status), ["timed-out"]);
});

test("完整检查汇总按 normal 最终退出码判断首轮 FAIL 日志", async t => {
  const parent = resolve(root, ".temp/.trash/normal-test-runner");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const stage of ["eslint", "tsc", "test", "build", "e2e", "release", "blueprint"]) {
    await writeFile(resolve(directory, `${stage}.exit`), "0");
  }
  await writeFile(resolve(directory, "test.log"), "FAIL first-round timeout\n常规测试结果: 通过\n");
  const invoke = () => spawnSync("bash", ["scripts/check/check-runner.sh", "summary", directory], { cwd: root, encoding: "utf8" });
  const recovered = invoke();
  assert.equal(recovered.status, 0);
  assert.doesNotMatch(recovered.stdout, /FAIL first-round timeout/u);
  await writeFile(resolve(directory, "test.exit"), "1");
  const failed = invoke();
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL first-round timeout/u);
});
