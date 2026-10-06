import { test } from "./harness/fixture";
import { verifyCloudflareRoundTrip } from "../helpers/cloudflare-contract";

// 唯一保留真实远端的 Cloudflare 契约用例：正常上传、下载、无变化检查和删除。
test("Cloudflare 真实后端：正常上传下载契约", async () => {
  test.setTimeout(180_000);
  await verifyCloudflareRoundTrip("https://endfield-api.richetriotour.net");
});
