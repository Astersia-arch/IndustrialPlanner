import { PlannerCandidateError } from "./model";
import type { WorldEntity } from "@/domain/document/world-document";
import type { RegistryContract } from "@/domain/registry/registry-contract";
import { resolveEntityGridRect } from "@/shared/geometry/power-range";

export interface PlannerOutline { readonly width: number; readonly height: number; }

/** 搜索盒子必须容纳固定设施，也至少容纳任一单体设备。 */
export function fixedOutlineMinimum(registry: RegistryContract,
  nodes: readonly { readonly entity: WorldEntity; readonly purpose: string; readonly external?: boolean }[]): PlannerOutline {
  return nodes.reduce((bounds, node) => {
    const definition = registry.queries.findEntityDefinition(node.entity.definitionId);
    if (!definition) throw new Error(`续搜布局引用了不存在的设备：${node.entity.definitionId}`);
    const rect = resolveEntityGridRect({ entity: node.entity, definition });
    const fixed = node.purpose === "bus" || node.external || node.entity.definitionId === "unloader_1"
      || node.entity.definitionId === "loader_1";
    return { width: Math.max(bounds.width, rect.width, fixed ? rect.x + rect.width : 1),
      height: Math.max(bounds.height, rect.height, fixed ? rect.y + rect.height : 1) };
  }, { width: 1, height: 1 });
}

/** 在面积边界上覆盖所有可行整数宽度；中点递归顺序让任意前缀分散于不同长宽比。 */
export function breadthOutlines(maximumArea: number, minimum: PlannerOutline, cap?: PlannerOutline): PlannerOutline[] {
  if (!Number.isSafeInteger(maximumArea) || maximumArea < 1) return [];
  const maxWidth = Math.min(cap?.width ?? Infinity, Math.floor(maximumArea / minimum.height));
  const shapes: PlannerOutline[] = [];
  for (let width = minimum.width; width <= maxWidth; width++) {
    const height = Math.min(cap?.height ?? Infinity, Math.floor(maximumArea / width));
    if (height >= minimum.height) shapes.push({ width, height });
  }
  const spread: PlannerOutline[] = [];
  const intervals: Array<readonly [number, number]> = [[0, shapes.length - 1]];
  for (let index = 0; index < intervals.length; index++) {
    const [start, end] = intervals[index]!;
    if (start > end) continue;
    const middle = Math.floor((start + end) / 2);
    spread.push(shapes[middle]!);
    intervals.push([start, middle - 1], [middle + 1, end]);
  }
  return spread;
}

export function breadthOutlineKey(mode: string, shape: PlannerOutline): string {
  return `${mode}/${shape.width}/${shape.height}`;
}

/** 优先未占用、访问次数最少的尺寸；分片文件以稳定宽度模数减少跨客户端重复。 */
export function selectBreadthOutline(shapes: readonly PlannerOutline[], mode: string,
  visits: (key: string) => number, occupied: ReadonlySet<string>, partition?: { readonly count: number; readonly index: number }): PlannerOutline | undefined {
  const assigned = partition ? shapes.filter(shape => shape.width % partition.count === partition.index) : shapes;
  const available = (choices: readonly PlannerOutline[]) => choices.filter(shape => !occupied.has(breadthOutlineKey(mode, shape)));
  const assignedFree = available(assigned);
  const globalFree = assignedFree.length ? assignedFree : available(shapes);
  const candidates = assignedFree.length ? assignedFree : globalFree.length ? globalFree : assigned.length ? assigned : shapes;
  return candidates.reduce<PlannerOutline | undefined>((best, shape) => !best
    || visits(breadthOutlineKey(mode, shape)) < visits(breadthOutlineKey(mode, best)) ? shape : best, undefined);
}

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
