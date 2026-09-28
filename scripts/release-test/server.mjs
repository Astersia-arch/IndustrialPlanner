import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

/** 只服务预先构建的文件；切换不会改动浏览器存储、URL 或缓存。 */
export async function startReleaseServer(builds, output, fixture) {
  let active = "A";
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".css": "text/css", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".mp3": "audio/mpeg" };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST" && url.pathname === "/__switch") {
        const label = url.searchParams.get("build");
        if (!["A", "B", "C"].includes(label)) { response.writeHead(400).end(); return; }
        await stat(resolve(builds, label, "release-build.json"));
        active = label;
        await appendFile(resolve(output, "switches.jsonl"), JSON.stringify({ active, at: new Date().toISOString() }) + "\n");
        response.writeHead(200, { "Cache-Control": "no-store" }).end();
        return;
      }
      if (request.method === "POST" && /^\/__evidence\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 64 * 1024 * 1024) throw Error("Evidence exceeds 64 MiB");
        }
        JSON.parse(body);
        await writeFile(resolve(output, url.pathname.split("/").at(-1) + ".json"), body);
        response.writeHead(200).end(); return;
      }
      if (url.pathname === "/__fixture.json") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(await readFile(fixture)); return;
      }
      const root = resolve(builds, active);
      let path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep) && path !== root) { response.writeHead(403).end(); return; }
      if (url.pathname.endsWith("/")) path = resolve(path, "index.html");
      const info = await stat(path);
      response.writeHead(200, {
        "Content-Type": mime[extname(path)] ?? "application/octet-stream", "Content-Length": info.size,
        "Cache-Control": path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(path).on("error", error => response.destroy(error)).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error.code === "ENOENT" ? 404 : 500, { "Cache-Control": "no-store" });
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // 重新绑定验证本次端口已经释放，验证完立即关闭。
      const probe = createServer();
      await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    },
  };
}
