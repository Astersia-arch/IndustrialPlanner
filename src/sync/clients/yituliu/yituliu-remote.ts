import { withStorageGeneration, assertLocalStorageGeneration } from "@/shared/storage/storage-generation";
import { assertYituliuSession, readYituliuSession, yituliuRequest, yituliuTargetKey, YituliuApiError } from '@/shared/storage/yituliu-session';
import { isSyncProviderTargetActive } from '@/shared/storage/sync-provider-activation';
import { createStableJsonHash, createSha256CanonicalHash } from '@/shared/storage/hash-utils';
import { readFromLocalStorage, trySaveToLocalStorage } from '@/shared/storage/browser-storage';
import { RemoteWriteConflictError } from '../remote-types';
import type { SyncRemote, SyncRemoteSession, SyncRemoteSessionContext, SyncLocalState, SyncRemoteCollection,
  RemoteCollectionIndex, RemoteAssetRef, RemoteAssetContent, RemoteCheckResult, SyncContentHashRequest,
  SyncRemoteWriteBatch, RemoteAssetPutParams, RemoteAssetTombstoneParams, RemoteApplyResult, RemoteWriteResult } from '../remote-types';
import { compressSnapshot, decompressSnapshot } from './codec';

const IDENTITY = { category: 'industrial-planner', version: '1', name: 'current' };
const ASSET_TYPES = new Set(['world-document', 'blueprint', 'blueprint-folder', 'custom-module', 'custom-module-folder', 'module-canvas', 'module-canvas-folder', 'planner-state']);
const COLLECTIONS = new Set(['world-documents', 'blueprints', 'blueprint-folders', 'custom-modules', 'custom-module-folders', 'module-canvases', 'module-canvas-folders', 'production-planning']);
interface Asset {
  collection: string;
  assetId: string;
  revision: number;
  contentHash: string | null;
  deletedAt: string | null;
  committedAt: string;
  value: unknown;
}
interface Snapshot { format: 1; revision: number; assets: Record<string, Asset> }
interface RecordState { id: number | null; hash: string | null; snapshot: Snapshot }
export interface YituliuTransport {
  request(path: string, init?: RequestInit): Promise<unknown>;
  assertActive(): void;
}

/** 单条当前快照是 CAS 提交边界，不保存历史正文或 patch 链。 */
export class YituliuSyncRemote implements SyncRemote {
  readonly localState: SyncLocalState;
  private readonly transport: YituliuTransport;
  private readonly controller = new AbortController();
  constructor(options?: { transport: YituliuTransport; localState: SyncLocalState }) {
    if (options) {
      this.transport = options.transport;
      this.localState = options.localState;
      return;
    }
    const session = readYituliuSession();
    const target = yituliuTargetKey(session);
    if (session === null || target === null) throw new Error('请先登录一图流');
    const assertActive = () => {
      assertLocalStorageGeneration();
      this.controller.signal.throwIfAborted();
      assertYituliuSession(session.id);
      if (!isSyncProviderTargetActive('yituliu', target)) throw new Error('一图流同步目标已切换');
    };
    this.transport = {
      assertActive,
      request: async (path, init) => {
        assertActive();
        const perform = () => yituliuRequest(session.id, path, { ...init, signal: this.controller.signal });
        const value = init?.method === "POST" ? await withStorageGeneration(perform) : await perform();
        assertActive();
        return value;
      },
    };
    this.localState = new YituliuLocalState(target, assertActive);
  }
  async beginSession(context: SyncRemoteSessionContext): Promise<SyncRemoteSession> {
    for (const collection of context.collections) if (!ASSET_TYPES.has(collection.assetType) || !COLLECTIONS.has(collection.adapterId)) throw new Error('一图流不支持该同步资产');
    return new YituliuRemoteSession(this.transport, this.localState);
  }
  dispose(): void { this.controller.abort(); }
  async resetRemote(): Promise<void> {
    const state = await readRecord(this.transport);
    const now = new Date().toISOString();
    const revision = state.snapshot.revision + 1;
    for (const asset of Object.values(state.snapshot.assets)) {
      asset.deletedAt = now; asset.value = null; asset.contentHash = null; asset.revision = revision; asset.committedAt = now;
    }
    state.snapshot.revision = revision;
    await writeRecord(this.transport, state);
  }
}

class YituliuLocalState implements SyncLocalState {
  constructor(private readonly target: string, private readonly assertActive: () => void) {}
  private key(kind: string, key: string): string { return `v3-yituliu-sync:${JSON.stringify([this.target, kind, key])}`; }
  private read<T>(kind: string, key: string): T | null { this.assertActive(); return readFromLocalStorage<T>(this.key(kind, key)); }
  private write(kind: string, key: string, value: unknown): void {
    this.assertActive();
    if (!trySaveToLocalStorage(this.key(kind, key), value)) throw new Error('无法保存一图流同步基线');
  }
  async getLastSyncedHash(key: string): Promise<string | null> { return this.read('hash', key); }
  async setLastSyncedHash(key: string, value: string | null): Promise<void> { this.write('hash', key, value); }
  async getRemoteRevision(key: string): Promise<number | null> { return this.read('revision', key); }
  async setRemoteRevision(key: string, value: number | null): Promise<void> { this.write('revision', key, value); }
  async getRemoteEtag(key: string): Promise<string | null> { return this.read('etag', key); }
  async setRemoteEtag(key: string, value: string | null): Promise<void> { this.write('etag', key, value); }
}

class YituliuRemoteSession implements SyncRemoteSession {
  private loaded: Promise<RecordState> | null = null;
  constructor(private readonly transport: YituliuTransport, public readonly localState: SyncLocalState) {}
  private load(): Promise<RecordState> { return this.loaded ??= readRecord(this.transport); }
  async computeContentHashes(requests: readonly SyncContentHashRequest[]): Promise<readonly string[]> {
    return Promise.all(requests.map(item => item.algorithm === 'sha256-canonical-json-v1' ? createSha256CanonicalHash(item.value) : createStableJsonHash(item.value)));
  }
  async prefetchIndexes(): Promise<void> { await this.load(); }
  async refreshIndexes(): Promise<void> { this.loaded = readRecord(this.transport); await this.loaded; }
  async readIndex(collection: SyncRemoteCollection): Promise<RemoteCollectionIndex> {
    const { snapshot, hash } = await this.load();
    const entries: RemoteCollectionIndex['entries'] = Object.create(null) as RemoteCollectionIndex['entries'];
    for (const asset of Object.values(snapshot.assets)) if (asset.collection === collection.adapterId) {
      entries[asset.assetId] = { revision: asset.revision, contentHash: asset.contentHash,
        deletedAt: asset.deletedAt, committedAt: asset.committedAt };
    }
    return { entries, revision: snapshot.revision, committedAt: null, etag: hash ?? 'missing' };
  }
  async readAsset(ref: RemoteAssetRef): Promise<RemoteAssetContent | null> {
    const asset = (await this.load()).snapshot.assets[assetKey(ref)];
    if (!asset || asset.deletedAt !== null || asset.contentHash === null) return null;
    const actual = (await this.computeContentHashes([{ algorithm: ref.collection.hashAlgorithm, value: asset.value }]))[0];
    if (actual !== asset.contentHash) throw new Error('一图流资产内容校验失败');
    return { revision: asset.revision, contentHash: asset.contentHash, value: asset.value, committedAt: asset.committedAt };
  }
  async checkCollections(collections: readonly SyncRemoteCollection[]): Promise<RemoteCheckResult> {
    const state = await this.load();
    const changed: string[] = [];
    for (const collection of collections) if (await this.localState.getRemoteEtag(collection.stateKey) !== (state.hash ?? 'missing')) changed.push(collection.adapterId);
    return { changedCollections: changed };
  }
  async markApplied(result: RemoteApplyResult): Promise<void> {
    this.transport.assertActive();
    if (!result.scopeComplete) return;
    if (result.collectionRevision !== null) await this.localState.setRemoteRevision(result.collection.stateKey, result.collectionRevision);
    // 只记录引擎实际应用的版本；本轮有上传时不提前标记未读取的集合。
    if (result.collectionEtag !== undefined) await this.localState.setRemoteEtag(result.collection.stateKey, result.collectionEtag);
  }
  beginWriteBatch(): SyncRemoteWriteBatch {
    const mutations: Array<{ type: 'put'; params: RemoteAssetPutParams } | { type: 'delete'; params: RemoteAssetTombstoneParams }> = [];
    let used = false;
    return {
      putAsset: params => { if (used) throw new Error('写入批次已结束'); mutations.push({ type: 'put', params }); },
      putTombstone: params => { if (used) throw new Error('写入批次已结束'); mutations.push({ type: 'delete', params }); },
      discard: async () => { used = true; mutations.length = 0; },
      commit: async () => {
        if (used) throw new Error('写入批次已结束');
        used = true;
        this.transport.assertActive();
        if (mutations.length === 0) return { writes: [] };
        const original = await this.load();
        const next = structuredClone(original);
        const revision = next.snapshot.revision + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('同步修订号超过上限');
        const committedAt = new Date().toISOString();
        const writes: RemoteWriteResult[] = [];
        for (const mutation of mutations) {
          const params = mutation.params;
          if (!ASSET_TYPES.has(params.collection.assetType) || !COLLECTIONS.has(params.collection.adapterId)) throw new Error('一图流不支持该同步资产');
          const key = assetKey(params);
          const old = original.snapshot.assets[key];
          if ((old?.contentHash ?? null) !== params.baseContentHash
            || (params.baseRevision !== null && old?.revision !== params.baseRevision)) throw new RemoteWriteConflictError([]);
          const deletedAt = mutation.type === 'delete' ? mutation.params.deletedAt : null;
          const contentHash = mutation.type === 'put' ? mutation.params.contentHash : null;
          next.snapshot.assets[key] = { collection: params.collection.adapterId, assetId: params.assetId,
            revision, committedAt, deletedAt, contentHash, value: mutation.type === 'put' ? structuredClone(mutation.params.value) : null };
          writes.push({ collection: params.collection, assetId: params.assetId, revision, committedAt, deletedAt, contentHash });
        }
        next.snapshot.revision = revision;
        const saved = await writeRecord(this.transport, next);
        this.loaded = Promise.resolve(saved);
        return { writes };
      },
    };
  }
}

function assetKey(ref: RemoteAssetRef): string { return JSON.stringify([ref.collection.adapterId, ref.assetId]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

async function readRecord(transport: YituliuTransport): Promise<RecordState> {
  const rows = await transport.request(`/oauth2/config/list?${new URLSearchParams(IDENTITY)}`);
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('一图流配置列表无效或存在重复快照');
  if (rows.length === 0) return { id: null, hash: null, snapshot: { format: 1, revision: 0, assets: {} } };
  const row: unknown = rows[0];
  if (!isRecord(row) || !Number.isSafeInteger(row.id) || typeof row.id !== 'number' || row.id <= 0
    || typeof row.hash !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(row.hash)) throw new Error('一图流快照元数据无效');
  const snapshot = await decompressSnapshot(row.config);
  if (!isRecord(snapshot) || snapshot.format !== 1 || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 || !isRecord(snapshot.assets)) throw new Error('一图流快照格式无效');
  for (const [key, asset] of Object.entries(snapshot.assets)) {
    if (!isRecord(asset) || typeof asset.collection !== 'string' || !COLLECTIONS.has(asset.collection) || typeof asset.assetId !== 'string'
      || key !== JSON.stringify([asset.collection, asset.assetId]) || !Number.isSafeInteger(asset.revision)
      || (asset.revision as number) <= 0 || (asset.revision as number) > (snapshot.revision as number)
      || typeof asset.committedAt !== 'string' || !(asset.deletedAt === null || typeof asset.deletedAt === 'string')
      || !(asset.contentHash === null || typeof asset.contentHash === 'string')
      || (asset.deletedAt === null && (asset.contentHash === null || asset.value === undefined))) throw new Error('一图流快照资产无效');
  }
  transport.assertActive();
  return { id: row.id, hash: row.hash, snapshot: snapshot as unknown as Snapshot };
}

async function writeRecord(transport: YituliuTransport, state: RecordState): Promise<RecordState> {
  const config = await compressSnapshot(state.snapshot);
  transport.assertActive();
  try {
    const saved = await transport.request(state.id === null ? '/oauth2/config/save' : '/oauth2/config/save-if-match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...IDENTITY, id: state.id, config, ...(state.id === null ? {} : { expectedHash: state.hash }) }),
    });
    if (!isRecord(saved) || typeof saved.id !== 'number' || !Number.isSafeInteger(saved.id) || saved.id <= 0
      || typeof saved.hash !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(saved.hash)) throw new Error('一图流保存响应无效');
    transport.assertActive();
    return { ...state, id: saved.id, hash: saved.hash };
  } catch (error) {
    if (error instanceof YituliuApiError && error.status === 409) throw new RemoteWriteConflictError([]);
    // 丢失响应时由下一轮读取当前快照判断；不盲目重发创建或覆盖。
    throw error;
  }
}
