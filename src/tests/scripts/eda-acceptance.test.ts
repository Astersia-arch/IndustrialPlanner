// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// 复用现有 Python 测试的 AST 装载方式，执行实际纯验收函数，不启动 Optuna 或训练进程。
function evaluate(records: unknown[]): Array<{ accepted: boolean; score: number }> {
  return JSON.parse(execFileSync("python3", ["-B", "-c", `
import ast,json,math,sys
from pathlib import Path
tree=ast.parse(Path('src/scripts/eda-training.py').read_text())
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('accepted','objective')]
namespace={'math':math}
exec(compile(ast.Module(body=functions,type_ignores=[]),'eda-training.py','exec'),namespace)
print(json.dumps([{'accepted':namespace['accepted'](record,25,30),'score':namespace['objective'](record,750)} for record in json.load(sys.stdin)]))
`], { input: JSON.stringify(records), encoding: "utf8", timeout: 10_000 }));
}

const valid = {
  outcome: "success", width: 20, height: 20, area: 400,
  search: { evaluations: 50_000, quality: { utilization: 0.4, secondary: 0 } },
  measuredOutputs: [{ perMinute: 30 }],
  constraints: { placementErrors: [], excessiveOperatingInputs: [] },
};

it("离线验收不以覆盖率设门槛，缺少观察指标也不拒绝已验证结果", () => {
  const records = [0.4, 0.5, 0.9].map(utilization => ({ ...valid,
    search: { ...valid.search, quality: { ...valid.search.quality, utilization } } }));
  const results = evaluate([...records, { ...valid, search: { evaluations: 50_000 } }]);
  expect(results.map(result => result.accepted)).toEqual([true, true, true, true]);
  expect(new Set(results.map(result => result.score)).size).toBe(1);
});

it("更小面积即使覆盖率下降且施工成本更高仍优先，覆盖率不影响同面积排名", () => {
  const results = evaluate([
    { ...valid, area: 399, width: 19, height: 21,
      search: { evaluations: 50_000, quality: { utilization: 0.3, secondary: 1_000_000 } } },
    { ...valid, search: { evaluations: 50_000, quality: { utilization: 0.99, secondary: -1_000_000 } } },
    valid, { ...valid, search: { ...valid.search, quality: { ...valid.search.quality, utilization: 0.99 } } },
  ]);
  expect(results.every(result => result.accepted)).toBe(true);
  expect(results[0]!.score).toBeLessThan(results[1]!.score);
  expect(results[2]!.score).toBe(results[3]!.score);
});

it("取消覆盖率门槛仍拒绝超尺寸、超预算、产量不足及非法结果", () => {
  const records = [
    { ...valid, width: 31 },
    { ...valid, search: { ...valid.search, evaluations: 50_001 } },
    { ...valid, outcome: "verification-failed" },
    { ...valid, measuredOutputs: [{ perMinute: 29 }] },
    { ...valid, measuredOutputs: [] },
    { ...valid, constraints: undefined },
    { ...valid, constraints: { placementErrors: ["overlap"], excessiveOperatingInputs: [] } },
    { ...valid, constraints: { placementErrors: [], excessiveOperatingInputs: ["excess"] } },
  ];
  expect(evaluate(records).map(result => result.accepted)).toEqual(records.map(() => false));
  expect(evaluate([{ ...valid, width: 30, height: 25 }])[0]!.accepted).toBe(true);
});
