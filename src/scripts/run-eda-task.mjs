import { register } from "tsx/esm/api";

register({ tsconfig: new URL("../../tsconfig.app.json", import.meta.url).pathname });
try {
  const { runHeadlessPlanner } = await import("./eda/headless.ts");
  await runHeadlessPlanner(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
