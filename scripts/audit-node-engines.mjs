#!/usr/bin/env node
/**
 * Node engines 审计：
 * 1. 仓库 manifest（根 + pnpm-workspace.yaml 全部 workspace 包）的 engines.node
 *    必须覆盖目标 Node 版本——任何一处不匹配直接 exit 1（fail-closed）。
 * 2. node_modules/.pnpm 内全部依赖的 engines.node 是否覆盖目标版本
 *    （默认当前运行时 Node）。
 *
 * 背景：仓库未启用 engine-strict。本脚本提供等价覆盖：声明了 engines.node
 * 且不覆盖目标版本的依赖都会被列出；超出 KNOWN_EXCEPTIONS 之外的违规令
 * 进程 exit 1。带 os/cpu 条件且不适用于当前平台的 optional 二进制依赖会被
 * 排除，避免跨平台包污染当前运行时审计。已接入根 package.json 的 `pretest`，
 * 随 `pnpm test` 自动执行。
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
import { fileURLToPath } from "node:url";
// 3.6-8：semver 改为根 devDependencies 显式声明（此前从 .pnpm 目录
// 「借用」——依赖树形态变化即断，且不参与 lockfile 锁定）。
import semver from "semver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --root 允许测试在夹具仓库上运行审计；默认为脚本所在仓库根。
const rootIdx = process.argv.indexOf("--root");
const repoRoot = rootIdx !== -1 && process.argv[rootIdx + 1]
  ? path.resolve(process.argv[rootIdx + 1])
  : path.resolve(__dirname, "..");

// 已记录在 docs/0814/node-runtime-matrix.md 的限时例外。若未来依赖再次
// 排除目标 Node，应在此精确钉版本并同步说明；若依赖恢复支持目标版本，
// 脚本会提示例外已失效，可从清单移除。
const KNOWN_EXCEPTIONS = new Set([]);

function targetNodeVersion() {
  const idx = process.argv.indexOf("--node");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.versions.node;
}

/** 当前安装平台是否满足包的 os/cpu 约束。 */
function isSupportedOnCurrentPlatform(pkg) {
  const matches = (constraint, value) => {
    if (!constraint) return true;
    const values = Array.isArray(constraint) ? constraint : [constraint];
    const positives = values.filter((item) => !String(item).startsWith("!"));
    const negatives = values.filter((item) => String(item).startsWith("!")).map((item) => String(item).slice(1));
    if (negatives.includes(value)) return false;
    return positives.length === 0 || positives.includes(value);
  };
  return matches(pkg.os, process.platform) && matches(pkg.cpu, process.arch);
}

/** 递归收集 .pnpm/<entry>/node_modules 下当前平台有效的 package.json。 */
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

/** 根 + 全部 workspace 包的 manifest 路径（相对仓库根）。任何 glob 未命中
 *  至少一个 manifest 视为配置错误（目录被改名/移走后静默缩小审计范围）。 */
function collectWorkspaceManifests() {
  const manifests = ["package.json"];
  const unmatchedGlobs = [];
  for (const glob of readWorkspaceGlobs()) {
    const segs = glob.split("/");
    const pattern = globToRegex(segs[segs.length - 1] || "*");
    const base = path.join(repoRoot, ...segs.slice(0, -1));
    if (!fs.existsSync(base)) {
      unmatchedGlobs.push(glob);
      continue;
    }
    let matched = false;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!pattern.test(entry.name)) continue;
      const manifest = path.join(base, entry.name, "package.json");
      if (fs.existsSync(manifest)) {
        manifests.push(path.relative(repoRoot, manifest));
        matched = true;
      }
    }
    if (!matched) unmatchedGlobs.push(glob);
  }
  return { manifests, unmatchedGlobs };
}

const target = targetNodeVersion();

// 第一层：仓库自身 manifest（根 + 全部 workspace 包）。缺失 engines.node
// 声明、范围不覆盖目标版本、范围无法解析、glob 未命中，全部视为违规并
// exit 1（fail-closed）——运行时契约必须显式声明，缺声明不是“通过”。
const manifestViolations = [];
const { manifests: workspaceManifests, unmatchedGlobs } = collectWorkspaceManifests();
if (unmatchedGlobs.length > 0) {
  console.error(`目标 Node 版本：${target}`);
  console.error(`\npnpm-workspace.yaml 的以下 glob 未命中任何 manifest（fail-closed）：`);
  for (const g of unmatchedGlobs) console.error(`  ${g}`);
  console.error("\nengines 审计未通过：workspace 范围解析异常，审计范围无法确认。");
  process.exit(1);
}
for (const manifest of workspaceManifests) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, manifest), "utf8"));
  } catch {
    manifestViolations.push([manifest, "manifest JSON 无法解析"]);
    continue;
  }
  const range = pkg.engines && pkg.engines.node;
  if (!range) {
    manifestViolations.push([manifest, "缺失 engines.node 声明"]);
    continue;
  }
  let ok;
  try {
    ok = semver.satisfies(target, range);
  } catch {
    ok = null;
  }
  if (ok === false) manifestViolations.push([manifest, `engines.node=${JSON.stringify(range)} 不覆盖 ${target}`]);
  else if (ok === null) manifestViolations.push([manifest, `engines.node=${JSON.stringify(range)} 无法解析`]);
}
if (manifestViolations.length > 0) {
  console.error(`目标 Node 版本：${target}`);
  console.error(`\n仓库 manifest 违规（${manifestViolations.length}）——必须显式声明且覆盖目标版本，fail-closed：`);
  for (const [m, reason] of manifestViolations) console.error(`  ${m}  ${reason}`);
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
  if (!isSupportedOnCurrentPlatform(pkg)) continue;
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
console.log(`仓库 manifest：${workspaceManifests.length}（根 + workspace 包，engines.node 全部显式声明且覆盖目标版本）`);
console.log(`依赖扫描唯一包：${seen.size}（声明 engines.node：${declared}；未声明的第三方包不作检验——engines 是 advisory，无法要求上游补声明）`);
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
