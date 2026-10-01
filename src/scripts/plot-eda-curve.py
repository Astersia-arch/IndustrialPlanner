"""从 EDA 标准报告绘制已验证最佳面积阶梯图，不插值、不补造成功数据。"""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager, ticker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    curve = report["proposalCurve"]
    if curve["schemaVersion"] not in (2, 3):
        raise ValueError("需要含真实覆盖率的 v2/v3 曲线；请从原始 records 重新汇总，不能用面积缩减比例替代。")
    total = curve["totalEvaluations"]
    improvements = curve["improvements"]
    selections = [point for point in curve["points"] if point.get("selected", point["improved"])]
    exact = curve["exact"]
    chinese = any(font.name == "WenQuanYi Zen Hei" for font in font_manager.fontManager.ttflist)
    if chinese:
        plt.rcParams["font.family"] = ["WenQuanYi Zen Hei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    label = lambda zh, en: zh if chinese else en
    fig, axes = plt.subplots(2, 2, figsize=(15, 8), sharex="col", gridspec_kw={"width_ratios": [1.25, 1]})
    best = curve["bestArea"]
    coverage = curve["bestCoverage"]
    title = label("累计提案数：面积与设备物流覆盖率", "Cumulative proposals: area and entity coverage")
    fig.suptitle(title, fontsize=18, fontweight="bold", x=0.07, ha="left")
    fig.text(0.07, 0.915, report.get("input", {}).get("plan", {}).get("name", "EDA"), fontsize=11, color="#475569")
    zoom_end = min(total, max(50000, selections[-1]["cumulativeEvaluations"] * 1.25)) if selections else total
    for column in range(2):
        area_ax, coverage_ax = axes[:, column]
        if selections:
            xs = [point["cumulativeEvaluations"] for point in selections] + [total]
            areas = [point["bestArea"] for point in selections] + [best]
            # 覆盖率来自同一个已验证最佳方案的真实占用并集，允许下降；缺失统计不能补成零。
            coverages = [point["bestCoverage"] for point in selections] + [coverage]
            percentages = [value * 100 if value is not None else float("nan") for value in coverages]
            area_ax.step(xs, areas, where="post", color="#146d87", linewidth=2.4)
            area_ax.scatter(xs[:-1], areas[:-1], color="#146d87", s=24, zorder=3)
            area_ax.set_ylim(min(areas) - max(8, (max(areas) - min(areas)) * 0.15),
                             max(areas) + max(15, (max(areas) - min(areas)) * 0.3))
            coverage_ax.step(xs, percentages, where="post", color="#21834c", linewidth=2.4)
            coverage_ax.scatter(xs[:-1], percentages[:-1], color="#21834c", s=24, zorder=3)
            known = [value * 100 for value in coverages if value is not None]
            if known:
                coverage_ax.set_ylim(max(0, min(known) - 5), min(100, max(known) + 7))
            else:
                coverage_ax.set_ylim(0, 100)
                coverage_ax.text(0.5, 0.5, label("缺少覆盖率统计", "Coverage unavailable"), transform=coverage_ax.transAxes, ha="center")
            for ax in (area_ax, coverage_ax):
                ax.axvspan(0, xs[0], color="#cbd5e1", alpha=0.4)
            if column == 1:
                for point in improvements:
                    area_ax.annotate(f'{point["cumulativeEvaluations"]:,}\n{point["width"]}×{point["height"]}={point["bestArea"]}',
                                     (point["cumulativeEvaluations"], point["bestArea"]),
                                     textcoords="offset points", xytext=(5, 10), fontsize=8)
                if coverage is not None:
                    coverage_ax.annotate(f'{coverage:.2%}  ({curve["bestOccupiedCells"]}/{best})',
                                         (selections[-1]["cumulativeEvaluations"], coverage * 100),
                                         textcoords="offset points", xytext=(5, 10), color="#21834c", fontsize=10)
        else:
            for ax in (area_ax, coverage_ax):
                ax.text(0.5, 0.5, label("本次运行没有有效解", "No validated solution"), transform=ax.transAxes, ha="center")
        area_ax.set_title(label("完整预算", "Full budget") if column == 0 else label("改善区间放大", "Improvement interval"), fontsize=12)
        area_ax.set_ylabel(label("最佳有效面积（格）", "Best validated area (cells)"))
        coverage_ax.set_ylabel(label("设备与物流覆盖率", "Device and logistics coverage"), color="#21834c")
        coverage_ax.yaxis.set_major_formatter(ticker.PercentFormatter(xmax=100))
        coverage_ax.set_xlabel(label("累计提案数", "Cumulative proposals") if exact else label("累计扣账配额（含上界估计）", "Charged budget (includes upper bounds)"))
        for ax in (area_ax, coverage_ax):
            ax.set_xlim(0, max(1, total if column == 0 else zoom_end))
            ax.xaxis.set_major_formatter(ticker.StrMethodFormatter("{x:,.0f}"))
            ax.xaxis.set_major_locator(ticker.MaxNLocator(nbins=5))
            ax.grid(alpha=0.2)
            ax.spines[["top", "right"]].set_visible(False)
    elapsed = report["elapsedMs"] / 1000
    coverage_text = f"{coverage:.2%}" if coverage is not None else "—"
    note = label(f"{total:,} 次计数 · {elapsed:.2f} 秒 · 最佳 {best if best is not None else '—'} 格 · 覆盖率 {coverage_text} · Dense 2 TPS\n"
                 "覆盖率＝全部交付实体逻辑占地并集÷包围矩形面积；含设备、物流、存取线和供电，重叠只计一次。\n"
                 "两条曲线对应同一最佳方案；覆盖率按实测绘制，允许波动。灰色区间尚无有效解。",
                 f"{total:,} counted proposals · {elapsed:.2f} s · best {best} cells · coverage {coverage_text} · Dense 2 TPS\n"
                 "Coverage = union of delivered entity cells / bounding-box area; overlaps counted once.\n"
                 "Both curves track the same incumbent. Coverage may decrease. Shaded region: no validated solution.")
    if not exact:
        note += label("\n存在未知计数，不能作为精确提案曲线。", "\nUnknown counts: this is not an exact proposal curve.")
    fig.text(0.07, 0.025, note, fontsize=10, color="#475569")
    fig.tight_layout(rect=(0.02, 0.15, 0.99, 0.9))
    try:
        for extension in ("png", "svg", "pdf"):
            fig.savefig(args.report.parent / f"proposal-area.{extension}", dpi=180, facecolor="white")
    finally:
        plt.close(fig)


# AI-REMOVED 2026-09-30:
# Reason: 面积相对首解缩减率不符合用户要求的设备与物流覆盖率。
# Trigger: 用户纠正图表指标并要求五百万提案实测。
# Evidence: quality.ts 已有交付实体占用并集统计；首解缩减率无法表达覆盖率。
# Replacement: 本文件 main，读取 proposalCurve v2 的 bestCoverage。
# Risk: 旧 v1 报告需由原始 records 显式重新汇总，不自动猜测覆盖率。
# Human Review: Required
# Original code:
# def main():
#     parser = argparse.ArgumentParser(description=__doc__)
#     parser.add_argument("report", type=Path)
#     args = parser.parse_args()
#     report = json.loads(args.report.read_text(encoding="utf-8"))
#     curve = report["proposalCurve"]
#     total = curve["totalEvaluations"]
#     improvements = curve["improvements"]
#     exact = curve["exact"]
#     chinese = any(font.name == "WenQuanYi Zen Hei" for font in font_manager.fontManager.ttflist)
#     if chinese:
#         plt.rcParams["font.family"] = ["WenQuanYi Zen Hei", "DejaVu Sans"]
#     plt.rcParams["axes.unicode_minus"] = False
#     label = lambda zh, en: zh if chinese else en
#     fig, axes = plt.subplots(1, 2, figsize=(13.5, 5.5), gridspec_kw={"width_ratios": [1.5, 1]})
#     best = curve["bestArea"]
#     baseline_area = improvements[0]["bestArea"] if improvements else None
#     title = label("累计提案数与最佳有效面积", "Cumulative proposals vs best validated area")
#     fig.suptitle(title, fontsize=18, fontweight="bold", x=0.07, ha="left")
#     fig.text(0.07, 0.90, report.get("input", {}).get("plan", {}).get("name", "EDA"), fontsize=11, color="#475569")
#     for index, ax in enumerate(axes):
#         if improvements:
#             xs = [point["cumulativeEvaluations"] for point in improvements] + [total]
#             ys = [point["bestArea"] for point in improvements] + [best]
#             area_line, = ax.step(xs, ys, where="post", color="#146d87", linewidth=2.5,
#                                  label=label("最佳有效面积", "Best validated area"))
#             ax.scatter(xs[:-1], ys[:-1], color="#146d87", zorder=3, s=35)
#             ax.axvspan(0, xs[0], color="#cbd5e1", alpha=0.4)
#             ax.set_ylim(min(ys) - max(8, (max(ys) - min(ys)) * 0.15), max(ys) + max(15, (max(ys) - min(ys)) * 0.3))
#             if index == 0:
#                 # 提升率以首个已验证解为固定基准；首次成功前与面积一样保持缺失。
#                 rates = [(baseline_area - area) / baseline_area * 100 for area in ys]
#                 rate_axis = ax.twinx()
#                 rate_line, = rate_axis.step(xs, rates, where="post", color="#21834c", linestyle="--", linewidth=2,
#                                             label=label("占地面积提升率", "Area improvement"))
#                 rate_axis.scatter(xs[:-1], rates[:-1], color="#21834c", marker="^", s=28, zorder=3)
#                 rate_axis.set_ylim(-2, max(10, rates[-1] * 1.3))
#                 rate_axis.yaxis.set_major_formatter(ticker.PercentFormatter(xmax=100))
#                 rate_axis.set_ylabel(label("占地面积提升率（相对首解）", "Area improvement vs first solution"), color="#21834c")
#                 rate_axis.tick_params(axis="y", colors="#21834c")
#                 rate_axis.spines["right"].set_color("#21834c")
#                 rate_axis.spines["top"].set_visible(False)
#                 rate_axis.annotate(f"{rates[-1]:.2f}%", (total, rates[-1]), textcoords="offset points",
#                                    xytext=(-8, 10), ha="right", color="#21834c", fontsize=11, fontweight="bold")
#                 ax.legend(handles=[area_line, rate_line], loc="upper left", frameon=False, fontsize=9)
#             if index == 1:
#                 for point in improvements:
#                     ax.annotate(f'{point["cumulativeEvaluations"]:,}\n{point["width"]}×{point["height"]}={point["bestArea"]}',
#                                 (point["cumulativeEvaluations"], point["bestArea"]),
#                                 textcoords="offset points", xytext=(5, 12), fontsize=9)
#         else:
#             ax.text(0.5, 0.5, label("本次运行没有有效解", "No validated solution"), transform=ax.transAxes, ha="center")
#         end = total if index == 0 else min(total, max(50000, improvements[-1]["cumulativeEvaluations"] * 1.25)) if improvements else total
#         ax.set_xlim(0, max(1, end))
#         ax.xaxis.set_major_formatter(ticker.StrMethodFormatter("{x:,.0f}"))
#         ax.set_xlabel(label("累计提案数", "Cumulative proposals") if exact else label("累计扣账配额（含上界估计）", "Charged budget (includes upper bounds)"))
#         ax.set_ylabel(label("最佳有效面积（格）", "Best validated area (cells)"))
#         ax.set_title(label("完整预算", "Full budget") if index == 0 else label("面积下降区间放大", "Improvement interval"), fontsize=12)
#         ax.grid(alpha=0.2)
#         ax.spines[["top", "right"]].set_visible(False)
#     elapsed = report["elapsedMs"] / 1000
#     first = improvements[0]["cumulativeEvaluations"] if improvements else None
#     final = improvements[-1]["cumulativeEvaluations"] if improvements else None
#     note = label(f"{total:,} 次计数 · {elapsed:.2f} 秒 · 最佳 {best if best is not None else '—'} 格 · Dense 2 TPS\n"
#                  f"首个有效解：{first}；最后改善：{final}。灰色区间尚无有效解；失败及较大候选不改变最佳值。",
#                  f"{total:,} counted proposals · {elapsed:.2f} s · best {best} cells · Dense 2 TPS\n"
#                  f"First solution: {first}; last improvement: {final}. Shaded region: no validated solution yet.")
#     if baseline_area is not None:
#         note += label(f"\n占地面积提升率 =（首解面积 {baseline_area} − 当前最佳面积）÷ {baseline_area} × 100%；最终提升 {(baseline_area - best) / baseline_area:.2%}。",
#                       f"\nArea improvement = ({baseline_area} - current best area) / {baseline_area} × 100%; final {(baseline_area - best) / baseline_area:.2%}.")
#     if not exact:
#         note += label("\n存在未知计数，不能作为精确提案曲线。", "\nUnknown counts: this is not an exact proposal curve.")
#     fig.text(0.07, 0.025, note, fontsize=10, color="#475569")
#     fig.tight_layout(rect=(0.02, 0.15, 0.99, 0.91))
#     try:
#         for extension in ("png", "svg", "pdf"):
#             fig.savefig(args.report.parent / f"proposal-area.{extension}", dpi=180, facecolor="white")
#     finally:
#         plt.close(fig)

if __name__ == "__main__":
    main()
