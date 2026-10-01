import { PlannerCandidateError } from "./model";

/** 停滞后枚举较小面积的整数长宽组合；允许一边增长，固定设施和显式边界始终是硬约束。 */
export function continuationOutline(seed: { width: number; height: number }, variant: number, step = 0,
  minimum = { width: 1, height: 1 }, cap?: { readonly width: number; readonly height: number }, maximumArea?: number) {
  if (maximumArea !== undefined && (!Number.isSafeInteger(maximumArea) || maximumArea < 1)) throw new Error("面积上限必须是正整数。");
  const shrink = { width: Math.max(1, seed.width - (variant % 2 ? 1 : 0)),
    height: Math.max(1, seed.height - (variant % 2 ? 0 : 1)) };
  if (step >= 2 || (maximumArea !== undefined && (shrink.width * shrink.height > maximumArea
    || shrink.width < minimum.width || shrink.height < minimum.height))) {
    const area = Math.min(seed.width * seed.height, (maximumArea ?? Infinity) + 1);
    const shapes = [{ width: seed.width - 1, height: seed.height }, { width: seed.width, height: seed.height - 1 }];
    for (let width = Math.max(1, Math.ceil(seed.width * 0.75)); width <= Math.floor(seed.width * 1.25); width++) {
      shapes.push({ width, height: Math.floor((area - 1) / width) });
    }
    // 2026-09-30：局部长宽窗口无解时仍检查固定设施可容纳的范围，不能回退到超面积盒子。
    if (maximumArea !== undefined && !shapes.some(shape => shape.width >= minimum.width && shape.height >= minimum.height
      && shape.width <= (cap?.width ?? Infinity) && shape.height <= (cap?.height ?? Infinity) && shape.width * shape.height < area)) {
      for (let width = minimum.width; width <= Math.min(cap?.width ?? Infinity, Math.floor((area - 1) / minimum.height)); width++) {
        shapes.push({ width, height: Math.min(cap?.height ?? Infinity, Math.floor((area - 1) / width)) });
      }
    }
    const unique = [...new Map(shapes.map(shape => [`${shape.width}/${shape.height}`, shape])).values()]
      .filter(shape => shape.width >= minimum.width && shape.height >= minimum.height
        && shape.width <= (cap?.width ?? Infinity) && shape.height <= (cap?.height ?? Infinity)
        && shape.width * shape.height < area)
      .sort((a, b) => b.width * b.height - a.width * a.height
        || Math.abs(a.width - seed.width) + Math.abs(a.height - seed.height)
          - Math.abs(b.width - seed.width) - Math.abs(b.height - seed.height)
        || a.width - b.width);
    if (unique.length) return unique[Math.max(0, step - 2) % unique.length]!;
  }
  const result = { width: Math.min(cap?.width ?? Infinity, shrink.width), height: Math.min(cap?.height ?? Infinity, shrink.height) };
  if (maximumArea !== undefined && (result.width * result.height > maximumArea || result.width < minimum.width || result.height < minimum.height)) {
    throw new PlannerCandidateError("本轮固定设施或显式边界无法容纳面积上限。");
  }
  return result;
}
