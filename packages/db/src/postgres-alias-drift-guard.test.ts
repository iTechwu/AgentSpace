// 行映射漂移守卫（3.2-3）：同步层 SQL 的 camelCase 输出别名必须带双引号。
//
// PG 会把不带引号的标识符折叠为小写：`AS workspaceId` 实际返回 `workspaceid`，
// 该键无下划线、机械 snake→camel 规则救不回，历史上只能靠 worker 内
// NORMALIZED_ROW_KEY_ALIASES 人工映射表恢复 —— 新别名漏登记即静默读 null。
// 3.2-3 已把全部存量别名改为 `AS "workspaceId"` 并删除人工表；本测试扫描
// 源码，任何新的未引号 camelCase 别名立即失败，防止漂移回潮。
//
// 同类断裂（codemod 后实证）：同一语句内别名已引号化，但 ORDER BY /
// GROUP BY / DISTINCT ON / USING 之后仍用裸 camelCase 引用该别名 ——
// 折叠成小写后与保留大小写的引号别名不匹配，直接报 column does not exist。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(import.meta.dirname);
const UNQUOTED_CAMEL_ALIAS = /\bAS\s+([a-z]+[A-Z][a-zA-Z0-9]*)\b/;
const UNQUOTED_CAMEL_REF = /\b(ORDER BY|GROUP BY|DISTINCT ON|USING)\s+\(?([a-z]+[A-Z][a-zA-Z0-9]*)\b/;

function listSourceFiles(directory = SOURCE_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist-types", "prisma", "postgres-schema", "node_modules"].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(absolute));
    else if (entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

test("sync-layer SQL aliases are quoted, not folded by Postgres", () => {
  const violations: string[] = [];
  for (const file of listSourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(import|export)\b/.test(line)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const match = line.match(UNQUOTED_CAMEL_ALIAS);
      if (match) violations.push(`${relative(SOURCE_ROOT, file)}:${index + 1}: AS ${match[1]}`);
      const ref = line.match(UNQUOTED_CAMEL_REF);
      if (ref) violations.push(`${relative(SOURCE_ROOT, file)}:${index + 1}: ${ref[1]} ${ref[2]}`);
    });
  }
  assert.deepEqual(
    violations,
    [],
    `发现未加引号的 camelCase 别名（AS 或 ORDER BY / GROUP BY / DISTINCT ON / USING 引用处）。PG 会把未引号标识符折叠为小写：AS 处读侧得到 null 键，引用处与引号别名大小写不匹配直接报错。请统一改为带双引号形式：\n${violations.join("\n")}`,
  );
});
