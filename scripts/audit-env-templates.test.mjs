import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  auditTemplateKeys,
  findNearDuplicateKeys,
  isEnvTemplateFile,
  levenshtein,
  listEnvTemplateFiles,
  parseEnvTemplate,
} from "./audit-env-templates.mjs";

test("env 模板发现：匹配全部命名形态，排除普通文件", () => {
  const files = [
    ".env.example",
    "deploy/self-hosted/.env.example",
    "deploy/staging/.env.staging.example",
    "deploy/systemd/dofe-agent.env.example",
    "deploy/daemon/managed-node.env.example",
    "scripts/feishu/env.example",
    "apps/web/.env.local.example",
    "README.md",
    "src/env.ts",
    "package.json",
  ];
  assert.deepEqual(listEnvTemplateFiles(files), [
    ".env.example",
    "apps/web/.env.local.example",
    "deploy/daemon/managed-node.env.example",
    "deploy/self-hosted/.env.example",
    "deploy/staging/.env.staging.example",
    "deploy/systemd/dofe-agent.env.example",
    "scripts/feishu/env.example",
  ]);
  assert.equal(isEnvTemplateFile("docs/env-guide.md"), false);
});

test("env 模板解析：跳过注释/空行，支持 export 前缀，记录行号", () => {
  const entries = parseEnvTemplate([
    "# 注释",
    "",
    "DATABASE_URL=postgres://localhost/app",
    "export DOFE_AGENT_SERVER_URL=https://example",
    "NOT_AN_ASSIGNMENT",
    "  # 缩进注释",
  ].join("\n"));
  assert.deepEqual(entries, [
    { key: "DATABASE_URL", line: 3 },
    { key: "DOFE_AGENT_SERVER_URL", line: 4 },
  ]);
});

test("键名审计：小写/数字开头/连字符与重复键都报 violation", () => {
  const violations = auditTemplateKeys("t.env.example", [
    { key: "GOOD_KEY", line: 1 },
    { key: "lowercase_key", line: 2 },
    { key: "1BAD", line: 3 },
    { key: "BAD-KEY", line: 4 },
    { key: "GOOD_KEY", line: 5 },
  ]);
  assert.equal(violations.length, 4);
  assert.match(violations[0], /不符合.*lowercase_key/);
  assert.match(violations[3], /重复键 GOOD_KEY.*第 1 行/);
});

test("levenshtein：基本距离正确", () => {
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("近重复检测：编辑距离 ≤ 2 命中，豁免表跳过已知合法对", () => {
  const flagged = findNearDuplicateKeys(new Map([
    ["DOFE_AGENT_APP_URL", ["a"]],
    ["DOFE_AGENT_PG_URL", ["b"]],
    ["DOFE_AGENT_APP_URLL", ["c"]],
    ["SHORT_X", ["d"]],
    ["SHORT_Y", ["e"]],
  ]));
  // 合法对被豁免；长度 < 8 的短键不检；仅误拼的 APP_URLL 被标记。
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /DOFE_AGENT_APP_URLL/);
});

test("真实仓库：audit 脚本 exit 0（发现 0 漂移）", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // pretest 环境外也可能被直接运行：git 不可用时跳过该端到端用例。
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    return;
  }
  const output = execFileSync("node", ["scripts/audit-env-templates.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(output, /env 模板审计通过：\d+ 个模板 \/ \d+ 个键/);
});

test("真实仓库：--list 输出模板清单", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!fs.existsSync(path.join(repoRoot, ".env.example"))) return;
  const output = execFileSync("node", ["scripts/audit-env-templates.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(output, /env 模板清单（\d+ 个）/);
});
