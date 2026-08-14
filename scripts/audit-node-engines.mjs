#!/usr/bin/env node
/**
 * Node engines 审计：
 * 1. 仓库 manifest（根 + pnpm-workspace.yaml 全部 workspace 包）的 engines.node
 *    必须覆盖目标 Node 版本——任何一处不匹配直接 exit 1（fail-closed）。
 * 2. node_modules/.pnpm 内全部依赖的 engines.node 是否覆盖目标版本
 *    （默认当前运行时 Node）。
 *
 * 背景：仓库未启用 engine-strict——它会被 jsdom@30 的 engines 声明单点阻断
 * （jsdom 只支持 LTS 线 22/24/26+，显式排除 Node 25，见
 * docs/0814/node-runtime-matrix.md 的限时例外）。本脚本提供等价覆盖：
 * 声明了 engines.node 且不覆盖目标版本的依赖都会被列出；超出
 * KNOWN_EXCEPTIONS 之外的违规令进程 exit 1。已接入根 package.json 的
 * `pretest`，随 `pnpm test` 自动执行。
 *
 * 已知局限：扫描基于当前平台实际安装的 node_modules/.pnpm，其他平台的
 * optionalDependencies 未安装时不会被检验；跨平台结论需在目标平台各跑一次。
 *
 * 用法：
 *   pnpm audit:engines
 *   pnpm test（pretest 自动执行）
 *   node scripts/audit-node-engines.mjs --node 25.9.0
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// 已记录在 docs/0814/node-runtime-matrix.md 的限时例外。精确钉版本：
// jsdom 升级后若仍排除 Node 25，会重新 exit 1，强制重新核对该例外；
// 若新版本纳入了 25，脚本会提示例外已失效、可从清单移除。
const KNOWN_EXCEPTIONS = new Set(["jsdom@30.0.1"]);

function targetNodeVersion() {
  const idx = process.argv.indexOf("--node");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.versions.node;
}

/** 从 .pnpm 里借用一份 semver，避免给仓库新增依赖。 */
function loadSemver() {
  const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
  const entries = fs.existsSync(pnpmDir)
    ? fs.readdirSync(pnpmDir).filter((e) => /^semver@\d/.test(e))
    : [];
  entries.sort((a, b) => {
    const va = a.slice("semver@".length).split(".").map(Number);
    const vb = b.slice("semver@".length).split(".").map(Number);
    return (vb[0] - va[0]) || (vb[1] - va[1]) || (vb[2] - va[2]);
  });
  for (const entry of entries) {
    const pkg = path.join(pnpmDir, entry, "node_modules", "semver", "package.json");
    if (fs.existsSync(pkg)) {
      try {
        return createRequire(pkg)("semver");
      } catch {
        // 尝试下一份
      }
    }
  }
  throw new Error("无法从 node_modules/.pnpm 加载 semver；请先 pnpm install");
}

/** 递归收集 .pnpm/<entry>/node_modules 下全部 package.json。 */
function collectPackageJsons(pnpmDir) {
  const files = [];
  for (const entry of fs.readdirSync(pnpmDir)) {
    const nm = path.join(pnpmDir, entry, "node_modules");
    if (!fs.existsSync(nm)) continue;
    const stack = [nm];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, child.name);
        if (child.isDirectory()) {
          if (child.name === ".bin") continue;
          stack.push(p);
        } else if (child.name === "package.json") {
          files.push(p);
        }
      }
    }
  }
  return files;
}

/** 极简解析 pnpm-workspace.yaml 的 packages 列表（带引号的 glob 数组）。 */
function readWorkspaceGlobs() {
  const yamlPath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(yamlPath)) return [];
  const lines = fs.readFileSync(yamlPath, "utf8").split("\n");
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const m = line.match(/^\s+-\s+"([^"]+)"\s*$/) || line.match(/^\s+-\s+(\S+)\s*$/);
      if (m) globs.push(m[1]);
      else if (/\S/.test(line)) inPackages = false; // 列表结束（如 catalog: 段）
    }
  }
  return globs;
}

/** 单层 glob（`*` 匹配一段内任意字符，不含 `/`）匹配目录名。 */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

/** 根 + 全部 workspace 包的 manifest 路径（相对仓库根）。 */
function collectWorkspaceManifests() {
  const manifests = ["package.json"];
  for (const glob of readWorkspaceGlobs()) {
    const segs = glob.split("/");
    const pattern = globToRegex(segs[segs.length - 1] || "*");
    const base = path.join(repoRoot, ...segs.slice(0, -1));
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!pattern.test(entry.name)) continue;
      const manifest = path.join(base, entry.name, "package.json");
      if (fs.existsSync(manifest)) manifests.push(path.relative(repoRoot, manifest));
    }
  }
  return manifests;
}

const target = targetNodeVersion();
const semver = loadSemver();

// 第一层：仓库自身 manifest（根 + 全部 workspace 包）。运行时/目标版本不在
// 声明范围内属于仓库级配置错误，直接 exit 1，不做“仅供参考”降级。
const manifestViolations = [];
const workspaceManifests = collectWorkspaceManifests();
for (const manifest of workspaceManifests) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, manifest), "utf8"));
  } catch {
    continue;
  }
  const range = pkg.engines && pkg.engines.node;
  if (!range) continue;
  let ok;
  try {
    ok = semver.satisfies(target, range);
  } catch {
    ok = null;
  }
  if (ok !== true) manifestViolations.push([manifest, range, ok === null]);
}
if (manifestViolations.length > 0) {
  console.error(`目标 Node 版本：${target}`);
  console.error(`\n仓库 manifest 违规（${manifestViolations.length}）——engines.node 不覆盖目标版本，fail-closed：`);
  for (const [m, r, unparseable] of manifestViolations) {
    console.error(`  ${m}  engines.node=${JSON.stringify(r)}${unparseable ? "（无法解析）" : ""}`);
  }
  console.error("\nengines 审计未通过：仓库 manifest 与目标 Node 版本不匹配。");
  process.exit(1);
}

const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
const seen = new Set();
const violations = [];
const unparseable = [];
let declared = 0;

for (const file of collectPackageJsons(pnpmDir)) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (!pkg.name || !pkg.version) continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const range = pkg.engines && pkg.engines.node;
  if (!range) continue;
  declared++;

  let ok;
  try {
    ok = semver.satisfies(target, range);
  } catch {
    ok = null;
  }
  if (ok === false) violations.push([key, range]);
  else if (ok === null) unparseable.push([key, range]);
}

const fresh = violations.filter(([k]) => !KNOWN_EXCEPTIONS.has(k));
const known = violations.filter(([k]) => KNOWN_EXCEPTIONS.has(k));
const stale = Array.from(KNOWN_EXCEPTIONS).filter((k) => !known.some(([vk]) => vk === k));

console.log(`目标 Node 版本：${target}`);
console.log(`仓库 manifest：${workspaceManifests.length}（根 + workspace 包，engines.node 全部覆盖目标版本）`);
console.log(`扫描唯一包：${seen.size}（其中声明 engines.node：${declared}）`);
console.log(`违规（engines.node 不覆盖 ${target}）：${violations.length}`);

if (known.length > 0) {
  console.log(`\n已记录的限时例外（${known.length}，见 docs/0814/node-runtime-matrix.md）：`);
  for (const [k, r] of known) console.log(`  [例外] ${k}  engines.node=${JSON.stringify(r)}`);
}
if (stale.length > 0) {
  console.log(`\n例外清单已失效（对应包不再违规或已不在依赖中，可移除）：`);
  for (const k of stale) console.log(`  [过期] ${k}`);
}
if (unparseable.length > 0) {
  console.log(`\n无法解析的 engines.node（${unparseable.length}，按违规处理）：`);
  for (const [k, r] of unparseable) console.log(`  ${k}  engines.node=${JSON.stringify(r)}`);
}
if (fresh.length > 0) {
  console.log(`\n未知违规（${fresh.length}）——这些依赖声明不支持 Node ${target}：`);
  for (const [k, r] of fresh) console.log(`  ${k}  engines.node=${JSON.stringify(r)}`);
}

if (fresh.length > 0 || unparseable.length > 0) {
  console.error(`\nengines 审计未通过：${fresh.length + unparseable.length} 个未知违规。`);
  process.exit(1);
}
console.log("\nengines 审计通过：无未知违规。");
