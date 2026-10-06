import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "dist");
let checked = 0;
async function inspect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await inspect(child);
    else if (/\.(?:js|html)$/.test(entry.name)) {
      const code = await readFile(child, "utf8");
      if (/__test__|installE2eBridge|无效的版本化测试蓝图/.test(code)) throw new Error(`生产产物含 E2E 接口：${child}`);
      checked++;
    }
  }
}
await inspect(directory);
if (!checked) throw new Error(`没有可检查的生产产物：${directory}`);
console.log(`生产隔离通过：${checked} 个 JS/HTML 文件不含 E2E 接口。`);
