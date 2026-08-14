import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "audit-node-engines.mjs");

// 审计依赖 node_modules/.pnpm 里的 semver 做范围判断；夹具仓库没有装依赖，
// 从本仓库借用同一份（symlink 整个 .pnpm/<semver@x> 目录）。
function linkSemverInto(fixtureRoot) {
  const pnpmDir = path.join(__dirname, "..", "node_modules", ".pnpm");
  const semverEntry = fs.readdirSync(pnpmDir).find((e) => /^semver@\d/.test(e));
  assert.ok(semverEntry, "repo node_modules/.pnpm 中找不到 semver，请先 pnpm install");
  const target = path.join(pnpmDir, semverEntry);
  const dest = path.join(fixtureRoot, "node_modules", ".pnpm", semverEntry);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.symlinkSync(target, dest, "dir");
}

/** 构造最小夹具仓库：根 manifest + pnpm-workspace.yaml + 可选 workspace 包。 */
function makeFixture({ rootEngines = "^25.9.0", workspaces = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engines-audit-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    engines: { node: rootEngines },
  }, null, 2));
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n");
  for (const ws of workspaces) {
    fs.mkdirSync(path.join(root, "packages", ws.name), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", ws.name, "package.json"), JSON.stringify({
      name: `@fixture/${ws.name}`,
      private: true,
      ...(ws.engines === undefined ? {} : { engines: { node: ws.engines } }),
    }, null, 2));
  }
  linkSemverInto(root);
  return root;
}

function runAudit(root, extraArgs = []) {
  const res = spawnSync(process.execPath, [scriptPath, "--root", root, ...extraArgs], {
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("engines 审计：全部 manifest 显式声明且覆盖 → exit 0", () => {
  const root = makeFixture({ workspaces: [{ name: "ok", engines: "^25.9.0" }] });
  try {
    const { code, stdout } = runAudit(root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /仓库 manifest：2/);
    assert.match(stdout, /审计通过/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：workspace 包缺失 engines.node 声明 → exit 1", () => {
  const root = makeFixture({ workspaces: [{ name: "silent" }] }); // 无 engines
  try {
    const { code, stderr } = runAudit(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /缺失 engines\.node 声明/);
    assert.match(stderr, /packages\/silent\/package\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：根 engines.node 不覆盖目标版本 → exit 1", () => {
  const root = makeFixture({ rootEngines: "^25.9.0", workspaces: [{ name: "ok", engines: "^25.9.0" }] });
  try {
    const { code, stderr } = runAudit(root, ["--node", "24.15.0"]);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /package\.json/);
    assert.match(stderr, /不覆盖 24\.15\.0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：workspace 范围不覆盖目标版本 → exit 1", () => {
  const root = makeFixture({ workspaces: [{ name: "old", engines: "^18.0.0" }] });
  try {
    const { code, stderr } = runAudit(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /packages\/old\/package\.json/);
    assert.match(stderr, /不覆盖/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：无效的 engines 范围按违规处理 → exit 1", () => {
  const root = makeFixture({ workspaces: [{ name: "weird", engines: "not-a-range" }] });
  try {
    const { code, stderr } = runAudit(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /packages\/weird\/package\.json/);
    assert.match(stderr, /不覆盖/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：workspace glob 未命中任何 manifest → exit 1（fail-closed）", () => {
  const root = makeFixture({}); // packages/* glob 无任何目录
  try {
    const { code, stderr } = runAudit(root);
    assert.equal(code, 1, stderr);
    assert.match(stderr, /未命中任何 manifest/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：依赖层违规超出 KNOWN_EXCEPTIONS → exit 1", () => {
  const root = makeFixture({ workspaces: [{ name: "ok", engines: "^25.9.0" }] });
  // 伪造一个声明 engines.node 不覆盖 25.9.0 的依赖包
  const depRoot = path.join(root, "node_modules", ".pnpm", "fake-pkg@1.0.0", "node_modules");
  fs.mkdirSync(path.join(depRoot, "fake-pkg"), { recursive: true });
  fs.writeFileSync(path.join(depRoot, "fake-pkg", "package.json"), JSON.stringify({
    name: "fake-pkg",
    version: "1.0.0",
    engines: { node: "^18.0.0" },
  }));
  try {
    const { code, stdout, stderr } = runAudit(root);
    assert.equal(code, 1, stderr);
    assert.match(stdout, /fake-pkg@1\.0\.0/);
    assert.match(stderr, /未通过/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("engines 审计：真实仓库自身必须通过（回归锚点）", () => {
  // 本仓库 11 个 manifest 均已显式声明 ^25.9.0——防止后续新包缺声明时
  // 又被静默放行。
  const res = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", cwd: path.join(__dirname, "..") });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /仓库 manifest：\d+/);
});
