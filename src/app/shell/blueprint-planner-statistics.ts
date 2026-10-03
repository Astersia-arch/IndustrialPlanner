import type { BlueprintPlannerAreaPoint, BlueprintPlannerProgress } from "@/domain/blueprint-planner";

interface ProposalRateSample {
  readonly taskId: string;
  readonly roundStart: number;
  readonly proposals: number;
  readonly elapsedMs: number;
  readonly rate: number | null;
}

export function plannerProposalRate(proposals: number, elapsedMs: number): number {
  return elapsedMs > 0 ? Math.round(proposals * 1000 / elapsedMs) : 0;
}

/** 仅保留一个约两秒的采样基点；有效计算时间不包含暂停间隔。 */
export function samplePlannerProposalRate(previous: ProposalRateSample | null,
  progress: Pick<BlueprintPlannerProgress, "taskId" | "status" | "evaluatedProposals" | "roundEvaluatedProposals" | "elapsedMs"> | null,
): ProposalRateSample | null {
  if (!progress) return null;
  const roundStart = progress.evaluatedProposals - progress.roundEvaluatedProposals;
  const current = { taskId: progress.taskId, roundStart, proposals: progress.evaluatedProposals,
    elapsedMs: progress.elapsedMs, rate: null };
  if (progress.status !== "running") return { ...current, rate: 0 };
  if (!previous || previous.taskId !== current.taskId || previous.roundStart !== roundStart
    || previous.proposals > current.proposals || previous.elapsedMs > current.elapsedMs) return current;
  const duration = current.elapsedMs - previous.elapsedMs;
  if (duration < 2000) return previous;
  return { ...current, rate: plannerProposalRate(current.proposals - previous.proposals, duration) };
}

/** log(1 + value) 保留零点；刻度和曲线共用同一映射，反向范围用于 Y 轴。 */
// AI-CORRECTION 2026-10-03: 用户确认只有 X 轴采用对数；Y 轴由 plannerAreaCoordinate 线性映射。
export function plannerLogCoordinate(value: number, maximum: number, start: number, end: number): number {
  return start + Math.log1p(value) / Math.log1p(Math.max(1, maximum)) * (end - start);
}

/** 面积按实际极值线性缩放并留白；只有一个面积值时保持在图表中间。 */
export function plannerAreaCoordinate(value: number, minimum: number, maximum: number, top: number, bottom: number): number {
  const padding = Math.max(1, (maximum - minimum) * 0.1);
  const lower = Math.max(0, minimum - padding), upper = maximum + padding;
  return bottom - (value - lower) / (upper - lower) * (bottom - top);
}

/** 保持真实线性 X 坐标；重叠的刻度文字换行，不丢弃任何面积下降点。 */
// AI-CORRECTION 2026-10-03: 用户改为合并连续密集下降的标签，仅保留最后一次；曲线数据不变。
// AI-CORRECTION 2026-10-03: 两轴改用 log(1+x)；必须保留零刻度，密集下降仍仅保留最后一次。
// AI-CORRECTION 2026-10-03: 用户最终选择 X 对数、Y 线性；本函数只负责 X 轴。
export function plannerAreaTicks(points: readonly BlueprintPlannerAreaPoint[], proposals: number, left: number, right: number) {
  const values = new Set<number>();
  let bestArea = Infinity;
  for (const point of points) {
    if (point.bestArea < bestArea) {
      values.add(point.evaluatedProposals);
      bestArea = point.bestArea;
    }
  }
  // AI-REMOVED 2026-10-03:
  // Reason: 密集标签改为合并，不再增加标签行数。Trigger: 用户要求连续快速下降只显示最后一个坐标。
  // Evidence: 原实现保留每个下降刻度并错行。Replacement: 下方相邻标签合并，下降坐标优先于轴端点。
  // Risk: 较早的密集下降次数不再直接显示于轴上，仍可从曲线圆点查看。Human Review: Required
  // Original code:
  // const rowEnds: number[] = [];
  // return [...values].sort((a, b) => a - b).map(value => {
  //   const x = left + value / Math.max(1, proposals) * (right - left);
  //   const label = value.toLocaleString();
  //   const labelWidth = label.length * 7;
  //   const labelX = Math.max(left, Math.min(right - labelWidth, x - labelWidth / 2));
  //   let row = rowEnds.findIndex(end => end + 10 <= labelX);
  //   if (row === -1) row = rowEnds.length;
  //   rowEnds[row] = labelX + labelWidth;
  //   return { value, x, label, labelX, row };
  // });
  const createTick = (value: number) => {
    const x = plannerLogCoordinate(value, proposals, left, right);
    const label = value.toLocaleString();
    const labelWidth = label.length * 7;
    const labelX = Math.max(left, Math.min(right - labelWidth, x - labelWidth / 2));
    return { value, x, label, labelX, labelWidth };
  };
  const ticks: ReturnType<typeof createTick>[] = [createTick(0)];
  for (const value of [...values].sort((a, b) => a - b)) {
    const tick = createTick(value);
    if (tick.labelX < ticks[0]!.labelX + ticks[0]!.labelWidth + 10) continue;
    while (ticks.length > 1 && ticks.at(-1)!.labelX + ticks.at(-1)!.labelWidth + 10 > tick.labelX) ticks.pop();
    ticks.push(tick);
  }
  for (const value of new Set([0, proposals])) {
    const tick = createTick(value);
    if (ticks.every(other => tick.labelX >= other.labelX + other.labelWidth + 10
      || other.labelX >= tick.labelX + tick.labelWidth + 10)) ticks.push(tick);
  }
  return ticks.sort((a, b) => a.value - b.value);
}

export function shouldWarnPlannerConcurrency(concurrency: number, hardwareConcurrency: number | undefined): boolean {
  return Number.isSafeInteger(concurrency) && concurrency > 2
    && hardwareConcurrency !== undefined && Number.isSafeInteger(hardwareConcurrency) && hardwareConcurrency > 0
    && concurrency > hardwareConcurrency - 2;
}
