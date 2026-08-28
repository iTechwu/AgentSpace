#!/usr/bin/env node
/**
 * env 模板漂移审计（3.6-6）：
 *
 * 背景：仓库并存多套 env 模板（根 .env.example、deploy/self-hosted、
 * deploy/systemd ×4、deploy/daemon ×3、deploy/feishu-worker、scripts/feishu），
 * 同一变量在多个模板间复制，人工维护必然漂移。完整「单一 schema 源 +
 * 生成器」会牺牲各模板自带的注释文档，这里先落机器强制的一致性下限：
 *
 * 1. 自动发现全部 git 跟踪的 env 模板（新增模板自动纳入，无需登记）；
 * 2. 键名规范：^[A-Z][A-Z0-9_]*$（小写/数字开头/连字符直接 fail）；
 * 3. 单模板内重复键：同文件定义两次的键 fail（后值静默覆盖前值）；
 * 4. 跨模板近重复键：编辑距离 ≤ 2 的键对（长度 ≥ 8）按疑似 typo fail ——
 *    这是「漂移」的主要形态：往一个模板加新变量时在另一个模板抄错拼写。
 *
 * 已接入根 package.json 的 `pretest`，随 `pnpm test` 自动执行。
 * 用 `node scripts/audit-env-templates.mjs --list` 查看当前模板清单。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** env 模板文件名形态：.env.example / xxx.env.example / .env.xxx.example / env.example */
const ENV_TEMPLATE_NAME =
  /(^|\/)(\.env(\.[a-z0-9-]+)?|[a-z0-9][a-z0-9.-]*\.env|env)\.example$/i;

export function isEnvTemplateFile(relativePath) {
  return ENV_TEMPLATE_NAME.test(relativePath);
}

export function listEnvTemplateFiles(trackedFiles) {
  return trackedFiles.filter(isEnvTemplateFile).sort();
}

/** 解析模板文本：返回按出现顺序的 { key, line } 列表（跳过注释与空行）。 */
export function parseEnvTemplate(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^export\s+([A-Za-z0-9_]+)\s*=/.exec(line) ?? /^([A-Za-z0-9_]+)\s*=/.exec(line);
    if (match) {
      entries.push({ key: match[1], line: index + 1 });
    }
  }
  return entries;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** 键名规范 + 单文件重复。返回 violation 数组（element: `${file}:${line}: ...`）。 */
export function auditTemplateKeys(relativePath, entries) {
  const violations = [];
  const seen = new Map();
  for (const entry of entries) {
    if (!KEY_PATTERN.test(entry.key)) {
      violations.push(`${relativePath}:${entry.line}: 键名不符合 ^[A-Z][A-Z0-9_]*$：${entry.key}`);
    }
    if (seen.has(entry.key)) {
      violations.push(
        `${relativePath}:${entry.line}: 重复键 ${entry.key}（首次定义于第 ${seen.get(entry.key)} 行）`,
      );
    } else {
      seen.set(entry.key, entry.line);
    }
  }
  return violations;
}

export function levenshtein(left, right) {
  if (left === right) return 0;
  const rows = left.length + 1;
  const columns = right.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let column = 1; column < columns; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * 已确认合法的近重复键对（主键 + 复数变体等语义并存），以排序后 `a|b` 形式登记。
 * 新增豁免必须在代码侧确认两个键都被真实读取。
 */
const KNOWN_NEAR_DUPLICATE_PAIRS = new Set([
  // 应用对外 URL vs Postgres 连接串。
  "DOFE_AGENT_APP_URL|DOFE_AGENT_PG_URL",
  // 主管理 token vs 轮换窗口的逗号分隔多 token（apps/mcp-egress-proxy/src/index.ts）。
  "MCP_EGRESS_PROXY_ADMIN_TOKEN|MCP_EGRESS_PROXY_ADMIN_TOKENS",
  // 品牌双文案字段。
  "NEXT_PUBLIC_BRAND_MISSION|NEXT_PUBLIC_BRAND_VISION",
  // 全局默认 cutover 模式 vs 按工作区覆盖表（workflows/feature-flags.ts）。
  "WORKFLOW_CUTOVER_MODE|WORKFLOW_CUTOVER_MODES",
]);

/**
 * 跨模板近重复：编辑距离 ≤ 2 且长度 ≥ 8 的键对视为疑似拼写漂移。
 * 输入为 Map<key, files[]>，返回描述字符串数组。
 */
export function findNearDuplicateKeys(keysByFile) {
  const keys = [...keysByFile.keys()].sort();
  const nearDuplicates = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const left = keys[i];
      const right = keys[j];
      if (Math.abs(left.length - right.length) > 2) continue;
      if (Math.min(left.length, right.length) < 8) continue;
      if (levenshtein(left, right) > 2) continue;
      if (KNOWN_NEAR_DUPLICATE_PAIRS.has(`${left}|${right}`)) continue;
      nearDuplicates.push(
        `${left}（${keysByFile.get(left).join(", ")}）≈ ${right}（${keysByFile.get(right).join(", ")}）`,
      );
    }
  }
  return nearDuplicates;
}

function readTrackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const trackedFiles = readTrackedFiles();
  const templates = listEnvTemplateFiles(trackedFiles);
  if (templates.length === 0) {
    console.error("env 模板审计：未发现任何 env 模板文件 —— 发现逻辑失效，fail-closed。");
    process.exit(1);
  }

  if (args.includes("--list")) {
    console.log(`env 模板清单（${templates.length} 个）：`);
    for (const template of templates) {
      const entries = parseEnvTemplate(fs.readFileSync(path.join(REPO_ROOT, template), "utf8"));
      const uniqueKeys = new Set(entries.map((entry) => entry.key));
      console.log(`  ${template}（${uniqueKeys.size} 键）`);
    }
    return;
  }

  const violations = [];
  const keysByFile = new Map();
  for (const template of templates) {
    const entries = parseEnvTemplate(fs.readFileSync(path.join(REPO_ROOT, template), "utf8"));
    violations.push(...auditTemplateKeys(template, entries));
    for (const entry of entries) {
      const files = keysByFile.get(entry.key);
      if (files) {
        if (!files.includes(template)) files.push(template);
      } else {
        keysByFile.set(entry.key, [template]);
      }
    }
  }
  for (const nearDuplicate of findNearDuplicateKeys(keysByFile)) {
    violations.push(`疑似拼写漂移：${nearDuplicate}`);
  }

  if (violations.length > 0) {
    console.error(`env 模板审计失败（${templates.length} 个模板 / ${keysByFile.size} 个键）：`);
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
    process.exit(1);
  }
  console.log(`env 模板审计通过：${templates.length} 个模板 / ${keysByFile.size} 个键，无漂移。`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
