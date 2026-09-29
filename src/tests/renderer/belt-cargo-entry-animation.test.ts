import { describe, expect, it } from "vitest";
import { BeltCargoEntryAnimation } from "@/renderer/scene/decorations/BeltCargoEntryAnimation";
import type { BeltPortExtensionEntry } from "@/renderer/scene/decorations/BeltVisualGeometry";

const extension: BeltPortExtensionEntry = {
  kind: "belt-output-to-device", beltEntityId: "belt", deviceEntityId: "device",
  boundary: { x: 1, y: 0.5 }, edge: "EAST", angleRadians: 0,
  localStartCells: 0, localEndCells: 0.2, spriteCenterXCells: -0.3,
};
function setup() {
  const animation = new BeltCargoEntryAnimation();
  let reads = 0;
  const input = {
    tick: 0, standardTickRate: 2, tickRate: 2, nowMs: 0, speed: 1,
    running: true, reset: false, enabled: true, halfBoxCells: 0.24,
    extensions: new Map([["belt", extension]]),
    readTransfers: () => {
      reads++;
      return [{ sourceDeviceId: "belt", targetDeviceId: "device", itemId: "ore", amount: 1 }];
    },
  };
  animation.update(input);
  return { animation, input, reads: () => reads };
}
describe("货物交接后的入口展示", () => {
  it("仅在新 tick 读取成功交接，按每格两秒推进并回收", () => {
    const { animation, input, reads } = setup();
    expect(reads()).toBe(0);
    expect(animation.update({ ...input, tick: 1, nowMs: 500 })[0]?.x).toBe(1);
    expect(animation.update({ ...input, tick: 1, nowMs: 750 })[0]?.x).toBe(1.125);
    expect(reads()).toBe(1);
    expect(animation.update({ ...input, tick: 3, nowMs: 1500, readTransfers: () => [] })).toEqual([]);
  });
  it("暂停冻结、恢复后继续，停滞快照最多外推一个真实 tick", () => {
    const { animation, input } = setup();
    animation.update({ ...input, tick: 1, nowMs: 500 });
    const point = animation.update({ ...input, tick: 1, nowMs: 750 });
    expect(animation.update({ ...input, tick: 1, nowMs: 900, running: false })).toEqual(point);
    expect(animation.update({ ...input, tick: 1, nowMs: 9000, running: false })).toEqual(point);
    expect(animation.update({ ...input, tick: 1, nowMs: 10000 })).toEqual(point);
    expect(animation.update({ ...input, tick: 1, nowMs: 20000 })[0]?.x).toBe(1.25);
  });
  it("关闭后立即清理且不读交接；重新开启不重播当前 tick", () => {
    const { animation, input, reads } = setup();
    animation.update({ ...input, tick: 1, nowMs: 500 });
    expect(animation.update({ ...input, tick: 1, enabled: false })).toEqual([]);
    expect(animation.update({ ...input, tick: 2, enabled: false })).toEqual([]);
    expect(reads()).toBe(1);
    expect(animation.update({ ...input, tick: 2 })).toEqual([]);
    expect(animation.update({ ...input, tick: 3 })).toHaveLength(1);
  });
  it("拒绝其他目标、失败交接；不因输入库存变化生成盒子", () => {
    const { animation, input } = setup();
    expect(animation.update({ ...input, tick: 1, readTransfers: () => [
      { sourceDeviceId: "belt", targetDeviceId: "other", itemId: "ore", amount: 1 },
      { sourceDeviceId: "belt", targetDeviceId: "device", itemId: "ore", amount: 0 },
    ] })).toEqual([]);
  });
  it("回放跳转或拓扑重置清理旧动画，连接移除也立即失效", () => {
    const { animation, input } = setup();
    animation.update({ ...input, tick: 2 });
    expect(animation.update({ ...input, tick: 1 })).toEqual([]);
    animation.update({ ...input, tick: 2 });
    expect(animation.update({ ...input, tick: 3, reset: true })).toEqual([]);
    animation.update({ ...input, tick: 4 });
    expect(animation.update({ ...input, tick: 4, extensions: new Map() })).toEqual([]);
    animation.clear();
    expect(animation.update({ ...input, tick: 5 })).toEqual([]);
  });
});
