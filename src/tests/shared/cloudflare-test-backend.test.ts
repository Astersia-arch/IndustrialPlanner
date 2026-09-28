// @vitest-environment node
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { startCloudflareTestBackend } from "../helpers/cloudflare-test-backend";
import { verifyCloudflareRoundTrip } from "../helpers/cloudflare-contract";

let backend: Awaited<ReturnType<typeof startCloudflareTestBackend>>;
afterEach(async () => { await backend?.close(); });

test("本地后端满足与真实后端共用的上传下载契约", async () => {
  backend = await startCloudflareTestBackend();
  await verifyCloudflareRoundTrip(backend.origin);
});

test("提交必须校验正文，未提交不可见，提交幂等且旧 revision 被拒绝", async () => {
  backend = await startCloudflareTestBackend();
  const root = `${backend.origin}/v1/sync/spaces/test`;
  const post = (url: string, data: unknown) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  await post(`${backend.origin}/v1/sync/spaces`, { spaceId: "test" });
  const body = { protocol: "cf-sync-v2", action: "prepare", baseRevision: "0", clientBatchId: randomUUID(),
    objects: [{ assetType: "planner-state", assetId: "single", blobHash: createHash("sha256").update("{}").digest("hex"),
      blobByteSize: 2, metadata: "{}", schemaVersion: 1, encoding: "identity", storageMode: "full" }], deletions: [] };
  const prepared = await (await post(`${root}/mutations`, body)).json();
  expect(await (await post(`${root}/mutations`, body)).json()).toEqual(prepared);
  const commit = { protocol: "cf-sync-v2", action: "commit", uploadId: prepared.uploadId, commitToken: prepared.commitToken };
  expect((await post(`${root}/mutations`, commit)).status).toBe(409);
  expect((await fetch(prepared.uploads[0].url, { method: "PUT", body: "[]" })).status).toBe(400);
  expect((await fetch(prepared.uploads[0].url, { method: "PUT", body: "{}" })).status).toBe(200);
  expect((await (await fetch(`${root}/plan`)).json()).assets).toEqual([]);
  const committed = await (await post(`${root}/mutations`, commit)).json();
  expect(committed.status).toBe("committed");
  expect(await (await post(`${root}/mutations`, commit)).json()).toEqual({ ...committed, status: "already-committed" });
  expect(await (await post(`${root}/mutations`, body)).json()).toMatchObject({ error: "batch_already_committed" });
  expect((await post(`${root}/mutations`, { ...body, clientBatchId: randomUUID() })).status).toBe(409);
});

test("门禁到达后保持响应挂起，显式放行才完成", async () => {
  backend = await startCloudflareTestBackend();
  const gate = backend.holdNext(({ path }) => path === "/health");
  let finished = false;
  const response = fetch(`${backend.origin}/health`).then((result) => { finished = true; return result; });
  await gate.waitForArrival();
  expect(finished).toBe(false);
  gate.release();
  expect((await response).status).toBe(200);
});
