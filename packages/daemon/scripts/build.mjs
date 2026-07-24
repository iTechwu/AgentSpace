import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(rootDir, "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    "agent-router": resolve(rootDir, "src", "agent-router", "cli.ts"),
    "agent-space": resolve(rootDir, "..", "..", "apps", "cli", "src", "index.ts"),
    cli: resolve(rootDir, "src", "cli.ts"),
    index: resolve(rootDir, "src", "index.ts"),
    "daemon-client": resolve(rootDir, "src", "daemon-client.ts"),
    "agent-router/index": resolve(rootDir, "src", "agent-router", "index.ts"),
  },
  outdir: outDir,
  bundle: true,
  external: ["agent-space-daemon"],
  // Provider SDKs still issue CommonJS dynamic requires. Keep ESM so daemon
  // entrypoints retain import.meta.url, and provide Node CommonJS globals.
  banner: {
    js: 'import { createRequire as __agentSpaceCreateRequire } from "node:module"; import { fileURLToPath as __agentSpaceFileURLToPath } from "node:url"; import { dirname as __agentSpaceDirname } from "node:path"; const require = __agentSpaceCreateRequire(import.meta.url); const __filename = __agentSpaceFileURLToPath(import.meta.url); const __dirname = __agentSpaceDirname(__filename);',
  },
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
});
