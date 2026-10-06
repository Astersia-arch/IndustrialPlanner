import { createServer } from "vite";
import { createBrowserTestPlugin } from "../browser-test/bridge-plugin.mjs";

const server = await createServer({ configFile: "vite.config.ts", plugins: [await createBrowserTestPlugin()],
  server: { host: "127.0.0.1", port: 4174, strictPort: true } });
let closing;
const close = () => closing ??= server.close().then(() => { process.exitCode = 0; });
process.once("SIGINT", close);
process.once("SIGTERM", close);
await server.listen();
server.printUrls();
