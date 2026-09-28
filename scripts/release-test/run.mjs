import { writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { chromium } from "playwright";
import { startReleaseServer } from "./server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const output = resolve(".temp/playwright-test/release", runId);
await mkdir(output, { recursive: true });
const children = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
});
async function command(executable, args, filename, timeout = 120_000, cleanup = false) {
  if (interrupted && !cleanup) throw Error("Release test interrupted");
  const file = filename ? await open(filename, "w") : null;
  let text = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); }, timeout);
      const consume = chunk => { text += chunk.toString(); if (file) writeSync(file.fd, chunk); };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.on("error", error => { clearTimeout(timer); children.delete(child); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer); children.delete(child);
        if (expired || code !== 0) reject(Error(`${executable} failed (${code ?? signal}${expired ? ", timeout" : ""})\n${text.slice(-4000)}`));
        else resolve();
      });
    });
  } finally {
    if (file) { await file.close(); }
  }
  if (/^### Error/m.test(text)) throw Error(`Playwright CLI reported failure\n${text.slice(0, 4000)}`);
  return text;
}
async function idle() {
  const sessions = await command("playwright-cli", ["list"]);
  if (!sessions.includes("(no browsers)")) throw Error(`Another Playwright session exists; close it before testing:\n${sessions}`);
  const processes = await command("ps", ["-eo", "args="]);
  if (processes.split("\n").some(line => /(?:node|npm exec).*playwright(?:\/\S*)?\s+test(?:\s|$)/.test(line))) throw Error("Another Playwright test runner is active");
}
const lockPath = resolve(".temp/playwright-test/release.lock");
let lock;
const results = [];
try {
  lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, runId }));
  await idle();
  console.log(`发布版测试 RUN_DIR=${output}`);
  for (const label of ["A", "B", "C"]) {
    console.log(`Build ${label}…`);
    await command(process.execPath, ["scripts/release-test/build.mjs", label, resolve(output, "builds", label)], resolve(output, `build-${label}.log`), 900_000);
  }
  const metadata = JSON.parse(await readFile(resolve(output, "builds/A/release-build.json"), "utf8"));
  const source = await readFile("src/tests/release/abac.test.ts", "utf8");
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  if (!javascript.includes("export default async function abac")) throw Error("Missing ABAC entry");
  for (const [name, width, height, dpr] of [["desktop", 2552, 1315, 1], ["tablet", 711, 665, 3.125], ["mobile", 764, 345, 3.125]]) {
    await idle();
    const directory = resolve(output, name);
    await mkdir(directory);
    const session = `release-${process.pid}-${name}`;
    const server = await startReleaseServer(resolve(output, "builds"), directory, resolve("src/tests/fixtures/blueprints/release/abac.schema6.json"));
    const config = resolve(directory, "cli.json");
    const code = resolve(directory, "abac.js");
    let profileResult;
    let profileError;
    try {
      await writeFile(config, JSON.stringify({ outputDir: directory, outputMode: "stdout", browser: {
        launchOptions: { headless: true, executablePath: chromium.executablePath() },
        contextOptions: { viewport: { width, height }, deviceScaleFactor: dpr, hasTouch: true },
      } }));
      await writeFile(code, `async page => {\n${javascript.replace("export default async function abac", "async function abac")}\nreturn abac(page, ${JSON.stringify({ origin: server.origin, output: directory, schema: metadata.baselineSchema })});\n}`);
      await command("playwright-cli", [`-s=${session}`, "open", "about:blank", `--config=${config}`], resolve(directory, "open.log"));
      await command("playwright-cli", [`-s=${session}`, "run-code", `--filename=${code}`], resolve(directory, "execution.log"), 600_000);
      const result = JSON.parse(await readFile(resolve(directory, "result.json"), "utf8"));
      if (result.passed !== true) throw Error("Missing successful ABAC result");
      profileResult = result;
    } catch (error) {
      profileError = error;
    } finally {
      const cleanupErrors = [];
      try { await command("playwright-cli", [`-s=${session}`, "close"], resolve(directory, "cleanup.log"), 60_000, true); }
      catch (error) { cleanupErrors.push(error); }
      try { await server.close(); } catch (error) { cleanupErrors.push(error); }
      try { await idle(); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) profileError = new AggregateError([...(profileError ? [profileError] : []), ...cleanupErrors], `Cleanup failed: ${name}`);
    }
    if (profileError) throw profileError;
    results.push({ name, ...profileResult });
    console.log(`PASS ABAC ${name}: ${profileResult.amounts.join(" → ")}`);
  }
  await writeFile(resolve(output, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
} catch (error) {
  console.error("FAIL 发布版测试", error);
  await writeFile(resolve(output, "result.json"), JSON.stringify({ passed: false, error: String(error), results }, null, 2));
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(lockPath); }
  console.log(`发布版测试证据: ${output}`);
}
