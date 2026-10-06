import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

/** 仅专用测试服务安装此插件；产品依赖图不引用测试模块。 */
export async function createBrowserTestPlugin() {
  const source = await readFile(resolve("src/tests/e2e/harness/browser-bridge.ts"), "utf8");
  const bridge = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  if (!bridge.includes("export function installE2eBridge")) throw new Error("缺少唯一 E2E 桥接入口");
  return {
    name: "industrial-planner-e2e-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/src/main.tsx")) return;
      const ast = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const entries = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "startWorkbench");
      if (entries.length !== 1 || !entries[0].body) throw new Error("工作台装配入口变化，停止注入测试接口");
      const position = entries[0].body.end - 1;
      const injected = bridge.replace("export function installE2eBridge", "function installE2eBridge");
      return { code: 'import { normalizeBlueprintDocument as e2eNormalizeBlueprint } from "@/shared/blueprints/blueprint-document-codec";\n'
        + 'import { ensureProtocolCoreEntity as e2eEnsureCore } from "@/editor/ensure-protocol-core";\n'
        + code.slice(0, position) + `\n${injected}\ninstallE2eBridge(appHost, e2eNormalizeBlueprint, e2eEnsureCore);\n` + code.slice(position), map: null };
    },
  };
}
