// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { compressSnapshot, decompressSnapshot, MAX_SNAPSHOT_BYTES } from '@/sync/clients/yituliu/codec';
import { YituliuSyncRemote, type YituliuTransport } from '@/sync/clients/yituliu/yituliu-remote';
import { YituliuApiError } from '@/shared/storage/yituliu-session';
import { createStableJsonHash, createSha256CanonicalHash } from '@/shared/storage/hash-utils';
import { RemoteWriteConflictError, type SyncLocalState, type SyncRemoteCollection } from '@/sync/clients/remote-types';

const collection: SyncRemoteCollection = { adapterId: 'blueprints', name: 'blueprints', mode: 'full-with-revision',
  assetType: 'blueprint', stateKey: 'blueprints', hashAlgorithm: 'fnv1a32',
  assetIdCodec: { toRemoteAssetId: id => id, toAdapterAssetId: id => id } };
function localState(): SyncLocalState {
  const values = new Map<string, unknown>();
  return {
    getLastSyncedHash: async key => values.get(`hash:${key}`) as string ?? null,
    setLastSyncedHash: async (key, value) => { values.set(`hash:${key}`, value); },
    getRemoteRevision: async key => values.get(`rev:${key}`) as number ?? null,
    setRemoteRevision: async (key, value) => { values.set(`rev:${key}`, value); },
    getRemoteEtag: async key => values.get(`etag:${key}`) as string ?? null,
    setRemoteEtag: async (key, value) => { values.set(`etag:${key}`, value); },
  };
}
/** 仅替代 HTTP 服务边界，执行真实 Provider、编解码和 hash。 */
function server() {
  let record: { id: number; hash: string; config: unknown } | null = null;
  let loseResponse = false;
  const requests: string[] = [];
  const transport: YituliuTransport = {
    assertActive() {},
    async request(path, init) {
      requests.push(path);
      if (path.startsWith('/oauth2/config/list')) return record ? [structuredClone(record)] : [];
      const body = JSON.parse(String(init?.body)) as { id: number | null; expectedHash?: string; config: unknown };
      if ((record === null && body.id !== null) || (record !== null && (body.id !== record.id || body.expectedHash !== record.hash))) throw new YituliuApiError(409, 10005);
      record = { id: 1, hash: (await createSha256CanonicalHash(body.config)).slice(7), config: body.config };
      if (loseResponse) { loseResponse = false; throw new TypeError('network response lost'); }
      return { id: record.id, hash: record.hash };
    },
  };
  return { transport, requests, read: () => record, loseNextResponse: () => { loseResponse = true; } };
}
async function session(transport: YituliuTransport, state = localState()) {
  return new YituliuSyncRemote({ transport, localState: state }).beginSession({ reason: 'manual', collections: [collection] });
}

describe('一图流压缩同步', () => {
  it('真实7核息壤蓝图无损往返，压缩收益显著', async () => {
    const blueprint: unknown = JSON.parse(readFileSync('public/blueprints/utimate-xiranite.json', 'utf8'));
    const encoded = await compressSnapshot(blueprint);
    expect(await decompressSnapshot(encoded)).toEqual(blueprint);
    expect(encoded.data.length).toBeLessThan(Buffer.byteLength(JSON.stringify(blueprint)) / 4);
  });
  it('拒绝未知格式、损坏 gzip 和解压超限', async () => {
    await expect(decompressSnapshot({ format: 2, encoding: 'gzip+base64', data: '' })).rejects.toThrow();
    await expect(decompressSnapshot({ format: 1, encoding: 'gzip+base64', data: 'AAAA' })).rejects.toThrow();
    const bomb = gzipSync(Buffer.alloc(MAX_SNAPSHOT_BYTES + 1)).toString('base64');
    await expect(decompressSnapshot({ format: 1, encoding: 'gzip+base64', data: bomb })).rejects.toThrow('上限');
  });
  it('两个客户端并发创建和更新均由CAS阻止丢失写入', async () => {
    const backend = server();
    const a = await session(backend.transport), b = await session(backend.transport);
    await a.prefetchIndexes([collection]); await b.prefetchIndexes([collection]);
    const value = { name: '初始蓝图', entities: {} };
    const first = a.beginWriteBatch();
    first.putAsset({ collection, assetId: 'a', value, contentHash: createStableJsonHash(value), baseRevision: null, baseContentHash: null });
    await first.commit();
    const stale = b.beginWriteBatch();
    stale.putAsset({ collection, assetId: 'b', value, contentHash: createStableJsonHash(value), baseRevision: null, baseContentHash: null });
    await expect(stale.commit()).rejects.toBeInstanceOf(RemoteWriteConflictError);
    const c = await session(backend.transport), d = await session(backend.transport);
    const base = await c.readAsset({ collection, assetId: 'a' });
    await d.prefetchIndexes([collection]);
    const update = c.beginWriteBatch(), conflict = d.beginWriteBatch();
    const nextValue = { name: '修改蓝图', entities: {} };
    const params = { collection, assetId: 'a', value: nextValue, contentHash: createStableJsonHash(nextValue), baseRevision: base!.revision, baseContentHash: base!.contentHash };
    update.putAsset(params); conflict.putAsset(params);
    await update.commit();
    await expect(conflict.commit()).rejects.toBeInstanceOf(RemoteWriteConflictError);
    expect(await (await session(backend.transport)).readAsset({ collection, assetId: 'a' })).toMatchObject({ value: nextValue });
  });
  it('更新替换旧正文，删除保留墓碑且不保留正文历史', async () => {
    const backend = server();
    const current = await session(backend.transport);
    const first = current.beginWriteBatch();
    first.putAsset({ collection, assetId: 'a', value: { name: 'old-content' }, contentHash: createStableJsonHash({ name: 'old-content' }), baseRevision: null, baseContentHash: null });
    await first.commit();
    const asset = await current.readAsset({ collection, assetId: 'a' });
    const remove = current.beginWriteBatch();
    remove.putTombstone({ collection, assetId: 'a', deletedAt: '2026-09-29T00:00:00Z', targetContentHash: asset!.contentHash, baseRevision: asset!.revision, baseContentHash: asset!.contentHash });
    await remove.commit();
    const remote = await session(backend.transport);
    expect((await remote.readIndex(collection)).entries.a?.deletedAt).not.toBeNull();
    expect(await remote.readAsset({ collection, assetId: 'a' })).toBeNull();
    const snapshot = await decompressSnapshot(backend.read()!.config);
    expect(JSON.stringify(snapshot)).not.toContain('old-content');
    expect(backend.requests.some(path => path.includes('/delete'))).toBe(false);
  });
  it('丢失成功响应后重读找回已保存内容，未推进本地基线', async () => {
    const backend = server(), state = localState();
    const current = await session(backend.transport, state);
    const batch = current.beginWriteBatch();
    const value = { name: 'persisted' };
    batch.putAsset({ collection, assetId: 'a', value, contentHash: createStableJsonHash(value), baseRevision: null, baseContentHash: null });
    backend.loseNextResponse();
    await expect(batch.commit()).rejects.toThrow('lost');
    expect(await state.getLastSyncedHash('a')).toBeNull();
    expect(await (await session(backend.transport)).readAsset({ collection, assetId: 'a' })).toMatchObject({ value });
  });
  it('切换账号后拒绝写入，完整和局部应用分别处理检查基线', async () => {
    const backend = server();
    let active = true;
    const transport = { ...backend.transport, assertActive: () => { if (!active) throw new Error('account changed'); } };
    const state = localState(), current = await session(transport, state);
    await current.markApplied({ collection, assetIds: [], scopeComplete: false, collectionRevision: 1, collectionEtag: 'old' });
    expect(await state.getRemoteEtag(collection.stateKey)).toBeNull();
    active = false;
    await expect(current.beginWriteBatch().commit()).rejects.toThrow('account changed');
  });
});
