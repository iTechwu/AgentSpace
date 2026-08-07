import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ERROR_CODE_SET, WORKFLOW_ERROR_CODES, WORKFLOW_ERROR_MESSAGE_ZH } from "./workflow-error-codes.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

// 覆盖所有会抛出 workflow_ 错误码的层：服务/仓储/前端特性 + API 路由。
const SOURCE_DIRS = [
  path.join(repoRoot, "packages/services/src/workflows"),
  path.join(repoRoot, "packages/db/src/workflows"),
  path.join(repoRoot, "apps/web/features/workflows"),
  path.join(repoRoot, "apps/web/app/api"),
];

// 仅匹配 throw new Error(...) 调用中作为首参的 workflow_ 字面量（任意引号），
// 按整文件文本匹配，兼容字面量独占一行的多行 throw 与反引号字面量。这会排除
// Prometheus 指标名（workflow_trigger_lag_seconds 等）、审计/事件码等同前缀字符串。
// 动态拼接码（`workflow_${x}`）无法静态捕获，已确认仓库内不存在此类用法。
const THROWN_WORKFLOW_CODE = /throw new Error\s*\(\s*["'`]workflow_[a-z0-9_]+/g;

function collectThrownWorkflowErrorCodes(): Set<string> {
  const codes = new Set<string>();
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        const text = fs.readFileSync(p, "utf8");
        const matches = text.match(THROWN_WORKFLOW_CODE);
        if (matches) {
          for (const m of matches) {
            codes.add(m.match(/workflow_[a-z0-9_]+/)![0]);
          }
        }
      }
    }
  }
  SOURCE_DIRS.forEach(walk);
  return codes;
}

test("WORKFLOW_ERROR_CODES has no duplicate entries and matches the naming pattern", () => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const code of WORKFLOW_ERROR_CODES) {
    if (seen.has(code)) duplicates.push(code);
    seen.add(code);
  }
  assert.deepEqual(duplicates, [], `WORKFLOW_ERROR_CODES must not list duplicates: ${duplicates.join(", ")}`);
  for (const code of WORKFLOW_ERROR_CODES) {
    assert.match(
      code,
      /^workflow_[a-z0-9_]+$/,
      `workflow error code must be snake_case with workflow_ prefix: ${code}`,
    );
  }
});

test("every thrown workflow error code is registered in WORKFLOW_ERROR_CODES", () => {
  const thrown = collectThrownWorkflowErrorCodes();
  // 卫兵：扫描必须真的发现代码，避免正则失配后静默通过。
  assert.ok(thrown.size > 0, "scan must discover at least one workflow error code literal");
  const missing = Array.from(thrown).filter((code) => !WORKFLOW_ERROR_CODE_SET.has(code));
  assert.deepEqual(
    missing,
    [],
    `workflow error codes thrown in source but missing from directory: ${missing.join(", ")}`,
  );
});

test("every registered workflow error code has a non-empty Chinese message", () => {
  for (const code of WORKFLOW_ERROR_CODES) {
    const message = WORKFLOW_ERROR_MESSAGE_ZH[code];
    assert.ok(message && message.trim().length > 0, `missing message for ${code}`);
    assert.notStrictEqual(
      message,
      "工作流操作未完成，请稍后重试。",
      `registered code ${code} must have a specific message, not the generic fallback`,
    );
  }
});
