import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import type { CfV2CommitResult, CfV2PlanResponse, CfV2PrepareResponse } from "../../sync/clients/cloudflare/cloudflare-v2-types";

/** 本地协议模拟器与真实服务共用同一正常路径契约，避免只验证模拟器自身。 */
export async function verifyCloudflareRoundTrip(origin: string) {
  const spaceId = `e2e-cf-contract-${randomUUID()}`;
  const root = `${origin}/v1/sync/spaces/${spaceId}`;
  const payload = JSON.stringify({ schemaVersion: 1, modules: [], marker: spaceId });
  const contentHash = createHash("sha256").update(payload).digest("hex");
  let revision = "0";
  let created = false;
  const call = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response;
  };
  const post = (url: string, body: unknown) => call(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const commit = async (deleting: boolean) => {
    const prepared = await (await post(`${root}/mutations`, {
      protocol: "cf-sync-v2", action: "prepare", baseRevision: revision, clientBatchId: randomUUID(),
      objects: deleting ? [] : [{ clientMutationId: randomUUID(), assetType: "planner-state", assetId: "single",
        metadata: "{}", blobHash: contentHash, blobByteSize: Buffer.byteLength(payload), storageMode: "full",
        schemaVersion: 1, encoding: "identity", writerAppVersion: "e2e", writerBuildId: "contract" }],
      deletions: deleting ? [{ clientMutationId: randomUUID(), assetType: "planner-state", assetId: "single" }] : [],
    })).json() as CfV2PrepareResponse;
    for (const upload of prepared.uploads) {
      if (upload.required) await call(upload.url!, {
        method: "PUT", headers: { "content-type": "application/octet-stream", ...upload.headers }, body: payload,
      });
    }
    const result = await (await post(`${root}/mutations`, { protocol: "cf-sync-v2", action: "commit",
      uploadId: prepared.uploadId, commitToken: prepared.commitToken })).json() as CfV2CommitResult;
    assert.notEqual(result.revision, revision);
    revision = result.revision;
  };
  try {
    await post(`${origin}/v1/sync/spaces`, { spaceId });
    created = true;
    await commit(false);
    const plan = await (await call(`${root}/plan`)).json() as CfV2PlanResponse;
    assert.equal(plan.revision, revision);
    const asset = plan.assets.find((item) => item.assetType === "planner-state" && item.assetId === "single");
    assert.ok(asset);
    assert.equal(asset.contentHash, contentHash);
    assert.equal(await (await call(asset.downloadUrl)).text(), payload);
    assert.equal((await call(`${root}/check?knownRevision=${encodeURIComponent(revision)}`)).status, 204);
  } finally {
    if (created) {
      // 失败时重新读取 revision，避免使用未记录的成功提交版本清理。
      const plan = await (await call(`${root}/plan`)).json() as CfV2PlanResponse;
      revision = plan.revision;
      if (plan.assets.length > 0) await commit(true);
      const cleared = await (await call(`${root}/plan`)).json() as CfV2PlanResponse;
      assert.equal(cleared.assets.length, 0);
    }
  }
}
