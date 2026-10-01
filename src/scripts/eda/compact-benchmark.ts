import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { BlueprintPlannerRequest } from "@/domain/blueprint-planner";
import { normalizeBlueprintDocument } from "@/shared/blueprints/blueprint-document-codec";
import { PlannerBatchSession, runPlannerBatch } from "./planner-runner";
import { rerouteReferenceLayout } from "./reference-analysis";
import { createLayoutPreview } from "./artifacts";
import { edaOutputPath } from "./artifact-paths";
import type { PlannerSearchSeed } from "@/blueprint-planner/search-seed";

/** 串行、固定五万共享提案；前四轮找可行解，未用完的配额继续压缩最佳已验证解。 */
async function main(): Promise<void> {
  const output = edaOutputPath("compact-benchmark", String(Date.now()));
  await mkdir(output, { recursive: true });
  const sourceFiles = (await readdir("src/blueprint-planner")).filter(name => /\.(ts|json)$/.test(name))
    .map(name => `src/blueprint-planner/${name}`).concat(["src/scripts/eda/planner-runner.ts", "src/scripts/eda/compact-benchmark.ts",
      "src/scripts/eda/reference-analysis.ts", "src/scripts/eda/node-planner-client.ts", "package-lock.json"]);
  await writeFile(resolve(output, "source-hashes.json"), JSON.stringify(Object.fromEntries(await Promise.all(sourceFiles.sort().map(async path =>
    [path, createHash("sha256").update(await readFile(path)).digest("hex")]))), null, 2));
  const session = new PlannerBatchSession();
  const references = [];
  try {
    for (const name of ["v1.5-copper-block-bud-needle-line", "v1.5-copper-block-separation-core-line", "v1.5-six-xiranite-full-speed-gas-solid-conversion"]) {
      const raw = await readFile(`public/blueprints/${name}.json`, "utf8");
      const blueprint = normalizeBlueprintDocument(JSON.parse(raw));
      if (!blueprint) throw new Error(`无效参考蓝图：${name}`);
      const deadline = performance.now() + 30_000;
      const result = await rerouteReferenceLayout(session.workspace.registry, blueprint, () => {
        if (performance.now() >= deadline) throw new Error("参考蓝图布线达到时间预算。");
      });
      if (result.status === "routed") {
        await writeFile(resolve(output, `${name}.json`), JSON.stringify(result.blueprint, null, 2));
        await writeFile(resolve(output, `${name}.svg`), createLayoutPreview(session.workspace.registry, result.blueprint));
      }
      references.push({ name, sha256: createHash("sha256").update(raw).digest("hex"), ...result, blueprint: undefined,
        verification: "geometry-only; original anchors, no changed supply/output infrastructure" });
    }
    const inputPath = "src/tests/blueprint-planner/fixtures/yazhen-syringe.json";
    const rawInput = await readFile(inputPath, "utf8");
    const request = JSON.parse(rawInput).request as BlueprintPlannerRequest;
    const common = { engineKind: "dense-v2" as const, attempts: 4, localEvaluations: 50_000,
      candidateSeconds: 30, verificationSeconds: 30, diagnostics: true };
    const baseline = await runPlannerBatch(request, { ...common, strategy: "baseline" }, session);
    console.log(JSON.stringify({ phase: "baseline", successes: baseline.successes, elapsedMs: baseline.elapsedMs }));
    const compact = await runPlannerBatch(request, { ...common, strategy: "compact" }, session);
    const best = compact.records.filter(record => record.outcome === "success").sort((a, b) => a.area! - b.area!)[0];
    const seed = best?.artifactPath ? JSON.parse(await readFile(resolve(best.artifactPath, "search-seed.json"), "utf8")) as PlannerSearchSeed : undefined;
    const remaining = common.localEvaluations - compact.localEvaluations;
    const continuation = seed && remaining > 0 ? await runPlannerBatch(request,
      { ...common, strategy: "compact", localEvaluations: remaining, startVariant: 4, seed }, session) : undefined;
    const records = [...compact.records, ...(continuation?.records ?? [])];
    const used = compact.localEvaluations + (continuation?.localEvaluations ?? 0);
    if (used > common.localEvaluations) throw new Error("压缩实验超出共享提案预算。");
    const report = { inputPath, inputSha256: createHash("sha256").update(rawInput).digest("hex"), references, baseline, compact, continuation,
      comparison: { baselineBest: Math.min(...baseline.records.filter(record => record.outcome === "success").map(record => record.area!)),
        compactBest: Math.min(...records.filter(record => record.outcome === "success").map(record => record.area!)),
        compactEvaluations: used, compactElapsedMs: compact.elapsedMs + (continuation?.elapsedMs ?? 0),
        referenceArea: 270, referenceAreaComparable: false,
        differences: ["人工参考不含完整存取线", "人工输出为仓库存货口，生成输出为协议储存箱和限速器", "人工单口供水采用未限速的不等需求分支，生成供料遵守现行硬约束"] } };
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, comparison: report.comparison, records: records.map(record => ({ outcome: record.outcome,
      area: record.area, generationMs: record.generationMs, verificationMs: record.verificationMs, evaluations: record.search?.evaluations,
      reusedRoutes: record.search?.reusedRoutes, artifactPath: record.artifactPath })) }));
  } finally { await session.dispose(); }
}

await main();
