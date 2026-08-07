import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ERROR_CODE_SET, WORKFLOW_ERROR_CODES, WORKFLOW_ERROR_MESSAGE_ZH } from "./workflow-error-codes.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

const SOURCE_DIRS = [
  path.join(repoRoot, "packages/services/src/workflows"),
  path.join(repoRoot, "packages/db/src/workflows"),
  path.join(repoRoot, "apps/web/features/workflows"),
];

function collectThrownWorkflowErrorCodes(): Set<string> {
  const codes = new Set<string>();
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        const text = fs.readFileSync(p, "utf8");
        const matches = text.match(/throw new Error\(["'](workflow_[a-z_]+)["']\)/g);
        if (matches) {
          for (const m of matches) {
            const code = m.match(/workflow_[a-z_]+/)![0];
            codes.add(code);
          }
        }
      }
    }
  }
  SOURCE_DIRS.forEach(walk);
  return codes;
}

test("every thrown workflow error code is registered in WORKFLOW_ERROR_CODES", () => {
  const thrown = collectThrownWorkflowErrorCodes();
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
