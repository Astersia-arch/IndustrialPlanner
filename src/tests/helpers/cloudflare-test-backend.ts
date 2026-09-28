import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type {
  CfV2CommitResult, CfV2PlanAsset, CfV2PrepareRequest, CfV2PrepareResponse, CfV2CommitRequest, CfV2CancelRequest,
} from "../../sync/clients/cloudflare/cloudflare-v2-types";

interface Transaction {
  request: CfV2PrepareRequest;
  prepared: CfV2PrepareResponse;
  blobs: Map<string, Buffer>;
  result?: CfV2CommitResult;
  cancelled: boolean;
}

interface Space {
  revision: string;
  epoch: number;
  assets: Map<string, { index: CfV2PlanAsset; bytes: Buffer }>;
  transactions: Map<string, Transaction>;
  active?: string;
}

export interface BackendRequest {
  method: string;
  path: string;
}

const keyOf = (type: string, id: string) => JSON.stringify([type, id]);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** HTTP 边界模拟；前端 Worker、同步引擎、迁移和存储仍执行真实实现。 */
export async function startCloudflareTestBackend() {
  const spaces = new Map<string, Space>();
  const gates = new Set<{
    matches: (request: BackendRequest) => boolean;
    arrive: () => void;
    released: Promise<void>;
    release: () => void;
  }>();
  const requests: BackendRequest[] = [];
  let origin = "";

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.destroyed) send(response, 500, { error: "test_backend_error", message: String(error) });
    });
  });

  function send(response: ServerResponse, status: number, value?: unknown) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(value === undefined ? undefined : JSON.stringify(value));
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    response.setHeader("access-control-allow-headers", "*");
    if (request.method === "OPTIONS") { send(response, 204); return; }
    const url = new URL(request.url ?? "/", origin);
    const observed = { method: request.method ?? "GET", path: url.pathname };
    requests.push(observed);
    for (const gate of [...gates]) {
      if (gate.matches(observed)) {
        gates.delete(gate);
        gate.arrive();
        await gate.released;
      }
    }
    if (response.destroyed) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const fail = (status: number, error: string) => send(response, status, { error, message: error });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.pathname === "/health") { send(response, 200, { ok: true }); return; }
    if (url.pathname === "/v1/sync/capabilities") {
      send(response, 200, { protocol: "cf-sync-v2", concurrency: "exclusive-space-upload", uploadTtlSeconds: 900,
        maxMutationsPerBatch: 32, maxMetadataSize: 262144, supportedStorageModes: ["full"],
        supportedEncodings: ["identity"], schemaVersions: [1], r2EnterThresholdBytes: 614400,
        d1ReturnThresholdBytes: 552960, maxR2BlobBytes: 26214400 });
      return;
    }
    if (parts[0] !== "v1" || parts[1] !== "sync" || parts[2] !== "spaces") { fail(404, "unknown_endpoint"); return; }
    if (parts.length === 3 && request.method === "POST") {
      const { spaceId } = JSON.parse(bytes.toString()) as { spaceId: string };
      if (!spaceId || typeof spaceId !== "string") { fail(400, "invalid_space"); return; }
      if (spaces.has(spaceId)) { fail(409, "space_exists"); return; }
      spaces.set(spaceId, { revision: "0", epoch: 0, assets: new Map(), transactions: new Map() });
      send(response, 201, { ok: true, spaceId, revision: "0", epoch: 0, createdAt: new Date().toISOString() });
      return;
    }
    const spaceId = parts[3]!;
    const space = spaces.get(spaceId);
    if (!space) { fail(404, "space_not_found"); return; }
    const root = `${origin}/v1/sync/spaces/${encodeURIComponent(spaceId)}`;
    const serverTime = new Date().toISOString();
    if (parts[4] === "plan" && request.method === "GET") {
      send(response, 200, { spaceId, revision: space.revision, epoch: space.epoch,
        assets: [...space.assets.values()].map((asset) => asset.index), serverTime });
      return;
    }
    if (parts[4] === "check" && request.method === "GET") {
      if (url.searchParams.get("knownRevision") === space.revision) send(response, 204);
      else send(response, 200, { revision: space.revision, epoch: space.epoch, changed: true, planRequired: true, serverTime });
      return;
    }
    if (parts[4] === "assets" && parts[7] === "content" && request.method === "GET") {
      const asset = space.assets.get(keyOf(parts[5]!, parts[6]!));
      if (!asset) { fail(404, "asset_not_found"); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(asset.bytes);
      return;
    }
    if (parts[4] === "uploads" && request.method === "PUT") {
      const tx = space.transactions.get(parts[5]!);
      if (!tx || tx.cancelled || tx.result) { fail(409, "invalid_transaction"); return; }
      if (url.searchParams.get("ticket") !== tx.prepared.commitToken) { fail(403, "invalid_ticket"); return; }
      const assetKey = keyOf(parts[7]!, parts[8]!);
      const object = tx.request.objects.find((item) => keyOf(item.assetType, item.assetId) === assetKey);
      if (!object || object.blobByteSize !== bytes.length || object.blobHash !== hash(bytes)) {
        fail(400, "invalid_asset_content"); return;
      }
      tx.blobs.set(assetKey, bytes);
      send(response, 200, { ok: true });
      return;
    }
    if (parts[4] !== "mutations" || request.method !== "POST") { fail(404, "unknown_endpoint"); return; }
    const body = JSON.parse(bytes.toString()) as CfV2PrepareRequest | CfV2CommitRequest | CfV2CancelRequest;
    if (body.protocol !== "cf-sync-v2") { fail(400, "invalid_protocol"); return; }
    if (body.action === "prepare") {
      const prior = [...space.transactions.values()].find((tx) => tx.request.clientBatchId === body.clientBatchId);
      if (prior) {
        if (JSON.stringify(prior.request) !== JSON.stringify(body)) { fail(409, "batch_payload_mismatch"); return; }
        if (prior.cancelled) { fail(409, "batch_cancelled"); return; }
        if (prior.result) { fail(409, "batch_already_committed"); return; }
        send(response, 200, prior.prepared); return;
      }
      if (body.baseRevision !== space.revision) { fail(409, "revision_conflict"); return; }
      if (space.active) { fail(409, "space_busy"); return; }
      if (!Array.isArray(body.objects) || !Array.isArray(body.deletions)
        || body.objects.length + body.deletions.length > 32) { fail(400, "invalid_mutations"); return; }
      const uploadId = randomUUID();
      const commitToken = randomUUID();
      const prepared: CfV2PrepareResponse = {
        status: "ready", uploadId, commitToken, baseRevision: space.revision,
        targetRevision: `revision-${randomUUID()}`, targetEpoch: space.epoch + 1,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        uploads: body.objects.map((object) => ({ assetType: object.assetType, assetId: object.assetId,
          required: true, backend: "d1", url: `${root}/uploads/${uploadId}/assets/${encodeURIComponent(object.assetType)}/${encodeURIComponent(object.assetId)}?ticket=${commitToken}` })),
      };
      space.transactions.set(uploadId, { request: body, prepared, blobs: new Map(), cancelled: false });
      space.active = uploadId;
      send(response, 200, prepared); return;
    }
    const tx = space.transactions.get(body.uploadId);
    if (!tx) { fail(404, "transaction_not_found"); return; }
    if (body.commitToken !== tx.prepared.commitToken) { fail(403, "invalid_commit_token"); return; }
    // JSON action 在运行时分派；prepare 类型只用于对象与删除列表的协议声明。
    const action: string = body.action;
    if (action === "cancel") {
      if (tx.result) { fail(409, "batch_already_committed"); return; }
      send(response, 200, { status: tx.cancelled ? "already-cancelled" : "cancelled", uploadId: body.uploadId });
      tx.cancelled = true;
      if (space.active === body.uploadId) space.active = undefined;
      return;
    }
    if (action !== "commit") { fail(400, "invalid_action"); return; }
    if (tx.result) { send(response, 200, { ...tx.result, status: "already-committed" }); return; }
    if (tx.cancelled) { fail(409, "batch_cancelled"); return; }
    if (tx.prepared.baseRevision !== space.revision) { fail(409, "revision_conflict"); return; }
    if (tx.request.objects.some((object) => !tx.blobs.has(keyOf(object.assetType, object.assetId)))) {
      fail(409, "missing_upload"); return;
    }
    const revision = tx.prepared.targetRevision;
    for (const object of tx.request.objects) {
      const assetKey = keyOf(object.assetType, object.assetId);
      space.assets.set(assetKey, { bytes: tx.blobs.get(assetKey)!, index: {
        assetType: object.assetType, assetId: object.assetId, contentHash: object.blobHash,
        byteSize: object.blobByteSize, encoding: object.encoding, metadata: object.metadata,
        schemaVersion: object.schemaVersion, storageMode: "full", backend: "d1", lastModifiedRevision: revision,
        downloadUrl: `${root}/assets/${encodeURIComponent(object.assetType)}/${encodeURIComponent(object.assetId)}/content`,
      } });
    }
    for (const deletion of tx.request.deletions) space.assets.delete(keyOf(deletion.assetType, deletion.assetId));
    space.revision = revision;
    space.epoch = tx.prepared.targetEpoch;
    space.active = undefined;
    tx.result = { status: "committed", uploadId: body.uploadId, revision, epoch: space.epoch,
      assets: tx.request.objects.map((object) => ({ assetType: object.assetType, assetId: object.assetId,
        contentHash: object.blobHash, lastModifiedRevision: revision })),
      deletedAssets: tx.request.deletions.map(({ assetType, assetId }) => ({ assetType, assetId })), serverTime };
    send(response, 200, tx.result);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("本地同步后端未监听 TCP 端口");
  origin = `http://127.0.0.1:${address.port}`;
  const releases = new Set<() => void>();
  return {
    origin,
    requests,
    /** 只拦住下一次匹配请求；先安装门禁，再触发受测动作。 */
    holdNext(matches: (request: BackendRequest) => boolean) {
      let arrive = () => {};
      let release = () => {};
      const arrived = new Promise<void>((resolve) => { arrive = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const gate = { matches, arrive, released, release };
      gates.add(gate);
      releases.add(release);
      return {
        async waitForArrival(timeoutMs = 60_000) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([arrived, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`后端门禁未到达；最近请求：${JSON.stringify(requests.slice(-10))}`)), timeoutMs);
            })]);
          } finally { clearTimeout(timer); }
        },
        release() { gates.delete(gate); releases.delete(release); release(); },
      };
    },
    async close() {
      for (const release of releases) release();
      gates.clear();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
