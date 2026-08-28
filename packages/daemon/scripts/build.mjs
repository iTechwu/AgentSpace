import { copyFileSync, mkdirSync, rmSync } from "node:fs";
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
    "dofe-agent": resolve(rootDir, "..", "..", "apps", "cli", "src", "index.ts"),
    cli: resolve(rootDir, "src", "cli.ts"),
    index: resolve(rootDir, "src", "index.ts"),
    "daemon-client": resolve(rootDir, "src", "daemon-client.ts"),
    "agent-router/index": resolve(rootDir, "src", "agent-router", "index.ts"),
  },
  outdir: outDir,
  bundle: true,
  external: ["dofe-agent-daemon"],
  // Provider SDKs still issue CommonJS dynamic requires. Keep ESM so daemon
  // entrypoints retain import.meta.url, and provide Node CommonJS globals.
  banner: {
    js: 'import { createRequire as __dofeAgentCreateRequire } from "node:module"; import { fileURLToPath as __dofeAgentFileURLToPath } from "node:url"; import { dirname as __dofeAgentDirname } from "node:path"; const require = __dofeAgentCreateRequire(import.meta.url); const __filename = __dofeAgentFileURLToPath(import.meta.url); const __dirname = __dofeAgentDirname(__filename);',
  },
  format: "esm",
  platform: "node",
  // 与 engines ^24.19.0 对齐：避免为 Node 24 原生支持的特性下兼容编译。
  target: "node24",
  sourcemap: false,
});

// 3.5-7：services 的 preloaded-skill-sources.ts 在模块顶层按
// import.meta.dirname 运行时读取同目录 JSON（3.3-6 有意外置，避免 tsc/
// web bundle 内联）。bundle 后该路径解析为 dist/，必须把数据文件一并
// 拷入，否则 dist/dofe-agent.js（tgz 部署到 provider 容器的入口）在
// import 时即 ENOENT 崩溃。dist-smoke.test.ts 守卫此契约。
copyFileSync(
  resolve(rootDir, "..", "services", "src", "agent-templates", "preloaded-skill-sources.json"),
  resolve(outDir, "preloaded-skill-sources.json"),
);
