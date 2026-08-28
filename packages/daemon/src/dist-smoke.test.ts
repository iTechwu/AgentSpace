import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// 3.5-7：单测全部跑 TS 源码，dist（esbuild bundle + CJS banner 注入）此前
// 只有 e2e 覆盖。本冒烟每次先重建（打包仅亚秒级）再加载全部入口，保证
// 被检验的永远是当前源码的产物：bundle 图可求值、banner 的 require/
// __filename/__dirname 注入不冲突、入口 isMain 守卫在测试进程下不触发。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const distDir = path.join(packageRoot, "dist");

execFileSync(process.execPath, [path.join(packageRoot, "scripts", "build.mjs")], {
  stdio: "inherit",
});

const daemonVersion = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version as string;

async function loadDist(rel: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.join(distDir, rel)).href) as Promise<Record<string, unknown>>;
}

test("dist 冒烟：dofe-agent CLI 入口（apps/cli bundle）导出 main", async () => {
  const mod = await loadDist("dofe-agent.js");
  assert.equal(typeof mod.main, "function");
});

test("dist 冒烟：daemon cli 入口导出 main，--version 与 package.json 一致", async () => {
  const mod = await loadDist("cli.js");
  assert.equal(typeof mod.main, "function");
  const res = spawnSync(process.execPath, [path.join(distDir, "cli.js"), "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), daemonVersion);
});

test("dist 冒烟：agent-router CLI 入口导出 main 与 help", async () => {
  const mod = await loadDist("agent-router.js");
  assert.equal(typeof mod.main, "function");
  assert.equal(typeof mod.printAgentRouterHelp, "function");
});

test("dist 冒烟：库入口（index / daemon-client / agent-router index）导出面完整", async () => {
  const index = await loadDist("index.js");
  assert.equal(typeof index.buildRemoteDaemonConfig, "function");
  assert.equal(typeof index.HttpDaemonClient, "function");

  const client = await loadDist("daemon-client.js");
  assert.equal(typeof client.HttpDaemonClient, "function");
  assert.equal(typeof client.DaemonAuthError, "function");

  const routerIndex = await loadDist(path.join("agent-router", "index.js"));
  assert.equal(typeof routerIndex.runAgentRouter, "function");
  assert.equal(typeof routerIndex.listAgentRouterHarnesses, "function");
});
