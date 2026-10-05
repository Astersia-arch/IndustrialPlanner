import { BufferImageSource, Container, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BuildingEffectBatch } from '@/renderer/building-effects/batch';
import type { BuildingEffectResource, EffectPlacement } from '@/renderer/building-effects/types';

const resource: BuildingEffectResource = {
  height: { file: 'height', width: 2, height: 2, min: 0, max: 1, pivot: [0, 0], center: [0, 0], pixelsPerCell: 1 },
  pages: [{ file: 'page-0', width: 4, height: 2 }, { file: 'page-1', width: 2, height: 4 }],
  frames: [
    { page: 0, x: 0, y: 0, width: 2, height: 2, durationMs: 100 },
    { page: 0, x: 2, y: 0, width: 2, height: 2, durationMs: 100 },
    { page: 1, x: 0, y: 2, width: 2, height: 2, durationMs: 100 },
  ],
  playback: { mode: 'loop', durationMs: 300, staticFrame: 0 },
};
const placements: EffectPlacement[] = [
  { id: 'port-0', resourceId: 'effect', x: 0, y: 0, rotation: 0, baseY: 0, epsilon: .01, ring: false },
  { id: 'port-1', resourceId: 'effect', x: 2, y: 0, rotation: 90, baseY: 1, epsilon: .01, ring: false },
];

function createTexture(width: number, height: number): Texture {
  return new Texture({ source: new BufferImageSource({ resource: new Uint8Array(width * height * 4), width, height }) });
}

describe('建筑端口特效批次资源生命周期', () => {
  it('原批次跨帧、跨颜色页及循环回首帧时更新 UV 和纹理，不重建几何', () => {
    const parent = new Container();
    const first = createTexture(4, 2), second = createTexture(2, 4), reloaded = createTexture(2, 4);
    const batch = new BuildingEffectBatch(parent, placements, resource, '0,0', first, first, first, 0, 0, 1);
    const geometry = batch.mesh.geometry;
    const buffers = [...geometry.buffers];
    try {
      for (const [frame, texture, expected] of [
        [0, first, [0, 0, .5, 0, .5, 1, 0, 1]],
        [1, first, [.5, 0, 1, 0, 1, 1, .5, 1]],
        [2, second, [0, .5, 1, .5, 1, 1, 0, 1]],
        [0, first, [0, 0, .5, 0, .5, 1, 0, 1]],
      ] as const) {
        batch.frame(frame, texture);
        expect(batch.mesh.geometry).toBe(geometry);
        expect(geometry.buffers).toEqual(buffers);
        expect(Array.from(geometry.getBuffer('aUV').data)).toEqual([...expected, ...expected]);
        expect(batch.mesh.shader!.resources.uColorTexture).toBe(texture.source);
        expect(parent.children).toEqual([batch.mesh]);
      }
      batch.frame(2, second);
      batch.frame(2, reloaded);
      expect(batch.mesh.shader!.resources.uColorTexture).toBe(reloaded.source);
      expect(buffers.every(buffer => !buffer.destroyed)).toBe(true);
    } finally {
      batch.destroy(); parent.destroy(); first.destroy(true); second.destroy(true); reloaded.destroy(true);
    }
  });

  it('退出批次立即销毁所有独占缓冲，同时保留其他批次使用的共享纹理和程序', () => {
    const parent = new Container(), texture = createTexture(4, 2);
    const first = new BuildingEffectBatch(parent, placements, resource, '0,0', texture, texture, texture, 0, 0, 1);
    const second = new BuildingEffectBatch(parent, placements, resource, '1,0', texture, texture, texture, 0, 0, 1);
    const buffers = [...first.mesh.geometry.buffers];
    const sharedProgram = first.mesh.shader!.glProgram;
    const unloaded = new Set<number>();
    for (const buffer of buffers) buffer.on('unload', () => unloaded.add(buffer.uid));
    try {
      expect(buffers).toHaveLength(5);
      expect(second.mesh.shader!.glProgram).toBe(sharedProgram);
      first.destroy();
      expect(buffers.every(buffer => buffer.destroyed)).toBe(true);
      expect(unloaded.size).toBe(5);
      expect(parent.children).toEqual([second.mesh]);
      expect(texture.destroyed).toBe(false);
      expect(texture.source.destroyed).toBe(false);
      expect(sharedProgram?.vertex).toContain('aPosition');
      second.frame(1, texture);
      expect(second.mesh.geometry.buffers.every(buffer => !buffer.destroyed)).toBe(true);
    } finally {
      if (!first.mesh.destroyed) first.destroy();
      second.destroy(); parent.destroy(); texture.destroy(true);
    }
  });
});
