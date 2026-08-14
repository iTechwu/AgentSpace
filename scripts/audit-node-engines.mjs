#!/usr/bin/env node
/**
 * Node engines 审计：检验 node_modules/.pnpm 内全部依赖的 engines.node
 * 是否覆盖目标 Node 版本（默认当前运行时 Node）。
 *
 * 背景：仓库未启用 engine-strict——它会被 jsdom@30 的 engines 声明单点阻断
 * （jsdom 只支持 LTS 线 22/24/26+，显式排除 Node 25，见
 * docs/0814/node-runtime-matrix.md 的限时例外）。本脚本提供等价覆盖：
 * 声明了 engines.node 且不覆盖目标版本的依赖都会被列出；超出
 * KNOWN_EXCEPTIONS 之外的违规令进程 exit 1，可作依赖变更后的门禁。
 *
 * 用法：
 *   pnpm audit:engines
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

const target = targetNodeVersion();
const semver = loadSemver();

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const rootRange = rootPkg.engines && rootPkg.engines.node;
if (rootRange && !semver.satisfies(target, rootRange)) {
  console.error(`警告：目标版本 ${target} 不在根 engines.node ${rootRange} 内，结果仅作参考。`);
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
