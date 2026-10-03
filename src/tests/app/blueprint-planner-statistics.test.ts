// @vitest-environment node
import { describe, expect, it } from "vitest";
import { plannerAreaCoordinate, plannerAreaTicks, plannerLogCoordinate, plannerProposalRate, samplePlannerProposalRate, shouldWarnPlannerConcurrency } from "@/app/shell/blueprint-planner-statistics";

describe("EDA 提案速度", () => {
  const initial = { taskId: "first", status: "running" as const, evaluatedProposals: 100,
    roundEvaluatedProposals: 100, elapsedMs: 1000 };

  it("累计速度按有效计算时间取整，零耗时不产生无限值", () => {
    expect(plannerProposalRate(1000, 0)).toBe(0);
    expect(plannerProposalRate(1000, 3000)).toBe(333);
  });

  it("约两秒采样一次，提案不增长时归零，不保存历史样本", () => {
    const first = samplePlannerProposalRate(null, initial);
    expect(first?.rate).toBeNull();
    expect(samplePlannerProposalRate(first, { ...initial, elapsedMs: 1500 })).toBe(first);
    const next = samplePlannerProposalRate(first, { ...initial, evaluatedProposals: 6100,
      roundEvaluatedProposals: 6100, elapsedMs: 3000 });
    expect(next?.rate).toBe(3000);
    expect(samplePlannerProposalRate(next, { ...initial, evaluatedProposals: 6100,
      roundEvaluatedProposals: 6100, elapsedMs: 5000 })?.rate).toBe(0);
  });

  it("暂停归零，切换任务、开始新轮和恢复较早检查点重新采样", () => {
    const first = samplePlannerProposalRate(null, initial);
    expect(samplePlannerProposalRate(first, { ...initial, status: "waiting" })?.rate).toBe(0);
    expect(samplePlannerProposalRate(first, { ...initial, taskId: "second", elapsedMs: 4000 })?.rate).toBeNull();
    expect(samplePlannerProposalRate(first, { ...initial, roundEvaluatedProposals: 0, elapsedMs: 4000 })?.rate).toBeNull();
    expect(samplePlannerProposalRate(first, { ...initial, evaluatedProposals: 50,
      roundEvaluatedProposals: 50, elapsedMs: 500 })?.rate).toBeNull();
    expect(samplePlannerProposalRate(first, null)).toBeNull();
  });
});

describe("EDA 面积下降刻度", () => {
  it("密集下降只标注最后一次，对数轴保留零点，单行标签不重叠、不越界", () => {
    const values = [1, 2, 3, 499999, 500000];
    const ticks = plannerAreaTicks(values.map((evaluatedProposals, index) => ({ evaluatedProposals, bestArea: 100 - index })), 500000, 46, 588);
    // AI-REMOVED 2026-10-03:
    // Reason: 用户改为密集下降合并标签。Trigger: 本轮 X 轴需求变更。
    // Evidence: 旧断言强制保留全部标签并错行。Replacement: 下方最新下降与单行避让断言。
    // Risk: Low。Human Review: Required
    // Original code:
    // expect(ticks.map(tick => tick.value)).toEqual([0, ...values]);
    // expect(ticks.find(tick => tick.value === 1)?.x).toBeCloseTo(46 + 542 / 500000);
    // expect(new Set(ticks.filter(tick => tick.value <= 3).map(tick => tick.row)).size).toBe(4);
    // for (let index = 1; index < ticks.length; index++) {
    //   const tick = ticks[index]!;
    //   for (const previous of ticks.slice(0, index).filter(value => value.row === tick.row)) {
    //     expect(tick.labelX).toBeGreaterThanOrEqual(previous.labelX + previous.label.length * 7 + 10);
    //   }
    // }
    expect(ticks.map(tick => tick.value)).toEqual([0, 3, 500000]);
    expect(ticks.find(tick => tick.value === 500000)?.x).toBe(588);
    expect(ticks.find(tick => tick.value === 3)?.x).toBeCloseTo(46 + 542 * Math.log(4) / Math.log(500001));
    for (const tick of ticks) {
      expect(tick.labelX).toBeGreaterThanOrEqual(46);
      expect(tick.labelX + tick.label.length * 7).toBeLessThanOrEqual(588);
    }
    for (let index = 1; index < ticks.length; index++) {
      const tick = ticks[index]!;
      const previous = ticks[index - 1]!;
      expect(tick.labelX).toBeGreaterThanOrEqual(previous.labelX + previous.labelWidth + 10);
    }
  });

  it("连续密集下降整组保留最后一次，轴端点不挤掉附近的下降标注", () => {
    const values = [100000, 120000, 140000, 160000, 300000, 499999];
    const points = values.map((evaluatedProposals, index) => ({ evaluatedProposals, bestArea: 100 - index }));
    const original = structuredClone(points);
    const ticks = plannerAreaTicks(points, 500000, 46, 588);
    expect(ticks.map(tick => tick.value)).toEqual([0, 499999]);
    expect(points).toEqual(original);
  });

  it("X 轴零点与端点精确对应，log(1+x) 支持正反坐标范围，零提案不产生无效坐标", () => {
    for (const [start, end] of [[58, 588], [160, 34]]) {
      expect(plannerLogCoordinate(0, 99, start!, end!)).toBe(start);
      expect(plannerLogCoordinate(99, 99, start!, end!)).toBeCloseTo(end!);
      expect(plannerLogCoordinate(9, 99, start!, end!)).toBeCloseTo((start! + end!) / 2);
      expect(plannerLogCoordinate(0, 0, start!, end!)).toBe(start);
    }
    const ticks = plannerAreaTicks([{ evaluatedProposals: 1, bestArea: 100 }], Number.MAX_SAFE_INTEGER, 58, 588);
    expect(ticks[0]!.value).toBe(0);
    expect(ticks[0]!.x).toBe(58);
  });

  it("Y 轴按实际面积范围线性缩放，等量下降具有相同距离且上下留白", () => {
    const y = (value: number) => plannerAreaCoordinate(value, 900, 1000, 34, 160);
    expect(y(1000)).toBeGreaterThan(34);
    expect(y(900)).toBeLessThan(160);
    expect(y(900) - y(1000)).toBeGreaterThan(100);
    expect(y(950)).toBeCloseTo(97);
    expect(y(975) - y(1000)).toBeCloseTo(y(950) - y(975));
    expect(y(950) - y(975)).toBeCloseTo(y(925) - y(950));
    expect(plannerAreaCoordinate(1950, 1900, 2000, 34, 160)).toBeCloseTo(y(950));
  });

  it("只有一个面积值时线居中，小幅改善仍可见且靠近零的面积坐标有限", () => {
    expect(plannerAreaCoordinate(500, 500, 500, 34, 160)).toBeCloseTo(97);
    expect(plannerAreaCoordinate(499, 499, 500, 34, 160)
      - plannerAreaCoordinate(500, 499, 500, 34, 160)).toBeGreaterThan(40);
    expect(plannerAreaCoordinate(1, 1, 1000, 34, 160)).toBeLessThan(160);
    expect(plannerAreaCoordinate(0, 0, 0, 34, 160)).toBe(160);
  });

  it("同提案次数的多次下降只需一个刻度，同面积不伪造下降点", () => {
    expect(plannerAreaTicks([
      { evaluatedProposals: 10, bestArea: 100 }, { evaluatedProposals: 10, bestArea: 90 },
      { evaluatedProposals: 20, bestArea: 90 }, { evaluatedProposals: 30, bestArea: 80 },
    ], 40, 0, 500).map(tick => tick.value)).toEqual([0, 10, 30, 40]);
    expect(plannerAreaTicks([], 0, 0, 500).map(tick => tick.value)).toEqual([0]);
  });
});

describe("EDA 并发警告", () => {
  it.each([1, 2, 3, 4, 8, 16, 32])("浏览器报告 %s 核时，1 和 2 并发永不警告", cores => {
    expect(shouldWarnPlannerConcurrency(1, cores)).toBe(false);
    expect(shouldWarnPlannerConcurrency(2, cores)).toBe(false);
  });

  it("只在严格超过核心数减二时警告", () => {
    expect(shouldWarnPlannerConcurrency(6, 8)).toBe(false);
    expect(shouldWarnPlannerConcurrency(7, 8)).toBe(true);
    expect(shouldWarnPlannerConcurrency(8, 8)).toBe(true);
    expect(shouldWarnPlannerConcurrency(3, 4)).toBe(true);
    expect(shouldWarnPlannerConcurrency(32, 64)).toBe(false);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 1.5])("核心数无效（%s）时不臆测系统能力", cores => {
    expect(shouldWarnPlannerConcurrency(8, cores)).toBe(false);
  });
});
