// @vitest-environment node

import { expect, it } from "vitest";
import { createProposalCurve } from "@/scripts/eda/proposal-curve";
import type { PlannerAttemptRecord } from "@/scripts/eda/planner-runner";

const record = (variant: number, evaluations: number, outcome: PlannerAttemptRecord["outcome"], area?: number, occupiedCells?: number): PlannerAttemptRecord => ({
  variant, evaluations, evaluationAccounting: "exact", elapsedMs: variant * 100, generationMs: 90, verificationMs: 10,
  outcome, area,
  search: occupiedCells === undefined ? undefined : {
    seed: variant, evaluationLimit: evaluations, outline: { width: area!, height: 1 }, evaluations,
    acceptedMoves: 0, routingAttempts: 0, initialWireLength: 0, finalWireLength: 0,
    quality: { secondary: 0, occupiedCells, utilization: occupiedCells / area!, excessFluidSources: 0,
      lengthPenalty: 0, turnPenalty: 0, adjacencyPairs: 0 },
  },
});

it("失败计入横轴；首次成功前为空，只有更小的有效面积形成下降点", () => {
  const records = [record(0, 10, "layout-failed"), record(1, 20, "success", 528),
    record(2, 5, "verification-failed", 100), record(3, 30, "success", 600),
    record(4, 40, "success", 441), record(5, 20, "success", 441), record(6, 50, "layout-failed")];
  const before = structuredClone(records);
  const curve = createProposalCurve(records);
  expect(curve.points.map(point => point.cumulativeEvaluations)).toEqual([10, 30, 35, 65, 105, 125, 175]);
  expect(curve.points.map(point => point.bestArea)).toEqual([null, 528, 528, 528, 441, 441, 441]);
  expect(curve.improvements.map(point => [point.cumulativeEvaluations, point.bestArea])).toEqual([[30, 528], [105, 441]]);
  expect(curve).toMatchObject({ exact: true, totalEvaluations: 175, bestArea: 441 });
  expect(records).toEqual(before);
});

it("未知超时消耗标记为上界，后续不得恢复为精确累计计数", () => {
  const curve = createProposalCurve([record(0, 10, "success", 500),
    { ...record(1, 50, "timeout"), evaluationAccounting: "upper-bound" }, record(2, 10, "success", 400)]);
  expect(curve.exact).toBe(false);
  expect(curve.points.map(point => point.exactCumulativeEvaluations)).toEqual([10, null, null]);
  expect(curve.improvements[1]).toMatchObject({ cumulativeEvaluations: 70, exactCumulativeEvaluations: null, bestArea: 400 });
});

it("零提案直接复验可以成功；无成功结果不能画成零面积", () => {
  expect(createProposalCurve([record(0, 0, "success", 400)]).improvements[0]).toMatchObject({ cumulativeEvaluations: 0, bestArea: 400 });
  expect(createProposalCurve([record(0, 100, "layout-failed")])).toMatchObject({ bestArea: null, improvements: [] });
  expect(createProposalCurve([])).toMatchObject({ bestArea: null, improvements: [], points: [], totalEvaluations: 0 });
});

it("损坏计数或成功面积不能静默进入评价曲线", () => {
  expect(() => createProposalCurve([record(0, -1, "layout-failed")])).toThrow("提案计数");
  expect(() => createProposalCurve([record(0, 1.5, "layout-failed")])).toThrow("提案计数");
  expect(() => createProposalCurve([record(0, 1, "success")])).toThrow("成功记录");
  expect(() => createProposalCurve([record(0, 1, "success", Infinity)])).toThrow("成功记录");
});

it("覆盖率跟随同一面积最佳方案，允许下降，不能取独立最高比例或用面积缩减率替代", () => {
  const curve = createProposalCurve([record(0, 10, "layout-failed"), record(1, 20, "success", 500, 400),
    record(2, 30, "success", 400, 280), record(3, 40, "success", 600, 590),
    record(4, 50, "verification-failed", 100, 99), record(5, 60, "success", 400, 390)]);
  expect(curve.points.map(point => point.bestCoverage)).toEqual([null, 0.8, 0.7, 0.7, 0.7, 0.7]);
  expect(curve.points.map(point => point.bestOccupiedCells)).toEqual([null, 400, 280, 280, 280, 280]);
  expect(curve.improvements.map(point => [point.bestArea, point.bestCoverage])).toEqual([[500, 0.8], [400, 0.7]]);
  expect(curve).toMatchObject({ schemaVersion: 3, bestArea: 400, bestCoverage: 0.7, bestOccupiedCells: 280 });
});

it("缺少覆盖率时保留缺失；超过面积或与并集格数不符的统计直接拒绝", () => {
  const curve = createProposalCurve([record(0, 10, "success", 500, 400), record(1, 20, "success", 400)]);
  expect(curve.points.map(point => point.bestCoverage)).toEqual([0.8, null]);
  expect(curve.bestCoverage).toBeNull();
  expect(() => createProposalCurve([record(0, 1, "success", 400, 401)])).toThrow("占用并集与覆盖率");
  expect(() => createProposalCurve([record(0, 1, "success", 400, -1)])).toThrow("占用并集与覆盖率");
  const corrupted = record(0, 1, "success", 400, 300);
  expect(() => createProposalCurve([{ ...corrupted, search: { ...corrupted.search!, quality: {
    ...corrupted.search!.quality!, utilization: 0.9,
  } } }])).toThrow("占用并集与覆盖率");
});

it("同面积少箱时覆盖率跟随实际选优，面积下降次数不增加", () => {
  const split = record(0, 10, "success", 100, 80), packed = record(1, 10, "success", 100, 70);
  const curve = createProposalCurve([
    { ...split, search: { ...split.search!, quality: { ...split.search!.quality!, outputStashCount: 2 } } },
    { ...packed, search: { ...packed.search!, quality: { ...packed.search!.quality!, outputStashCount: 1, secondary: 100 } } },
  ]);
  expect(curve.bestCoverage).toBe(0.7);
  expect(curve.points[1]).toMatchObject({ selected: true, improved: false, bestOutputStashCount: 1 });
  expect(curve.improvements).toHaveLength(1);
});
