// 手写 SQL 列名漂移守卫（3.2-5）：
//
// 决策背景：不引入 Kysely 等 typed query builder —— 它是纯异步 API，套不进
// worker_thread 同步层；且 Prisma Phase 2 正在逐域替换该层，再加第二个
// query builder 是反向投资。编译期列名校验以「schema DDL 为唯一事实源 +
// 测试期静态扫描」实现，零运行时依赖。
//
// 本测试做两件事：
// 1. 解析 postgres-schema/statements/*.ts 的 CREATE TABLE / ALTER TABLE
//    ADD COLUMN，构建 表 → 列集合 的唯一事实源；
// 2. 扫描 src/ 下所有 SQL（模板字符串与测试文件中的双引号字符串）：
//    - 限定引用 `table.column` / `table."column"`（qualifier 命中已知表才校验，
//      EXCLUDED/NEW/OLD/别名等未知 qualifier 直接跳过）；
//    - `INSERT INTO table (col, ...)` 列清单逐列校验。
// 任何引用到不存在的列立即失败 —— 这类 typo 目前只能靠运行时 PG 报错，
// 且多数路径测试覆盖不到。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = import.meta.dirname;
const STATEMENTS_ROOT = join(SOURCE_ROOT, "postgres-schema", "statements");

const COLUMN_DEF = /^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/;
const TABLE_OPEN = /^\s*CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_]+)\s*\(/i;
const TABLE_CLOSE = /^\s*\)/;
const ALTER_OPEN = /^\s*ALTER TABLE (?:IF EXISTS )?([a-z0-9_]+)/i;
const ALTER_ADD_COLUMN = /^\s*ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/i;
const ALTER_DROP_COLUMN = /^\s*DROP COLUMN (?:IF EXISTS )?([a-z_][a-z0-9_]*)/i;
const OTHER_STATEMENT = /^\s*(CREATE|DROP|UPDATE|INSERT|COMMENT|GRANT|REVOKE|DO|SELECT|ANALYZE|REINDEX)\b/i;
const CONSTRAINT_PREFIX = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE)\b/i;

function listFiles(directory: string, suffix = ".ts"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist-types", "node_modules"].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute, suffix));
    else if (entry.name.endsWith(suffix)) files.push(absolute);
  }
  return files;
}

function parseSchemaColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const columnsOf = (name: string) => {
    let set = tables.get(name);
    if (!set) {
      set = new Set<string>();
      tables.set(name, set);
    }
    return set;
  };
  for (const file of listFiles(STATEMENTS_ROOT)) {
    let current: string | null = null;
    let alterTable: string | null = null;
    for (const rawLine of readFileSync(file, "utf8").split("\n")) {
      // 单行语句形态行首带模板反引号（`ALTER TABLE ...），剥掉再匹配。
      const line = rawLine.replace(/^\s*`/, "");
      // 语句均以独立模板字符串承载、无分号结尾，任何新语句关键字都复位 ALTER 状态。
      const open = line.match(TABLE_OPEN);
      if (open) {
        current = open[1];
        alterTable = null;
        continue;
      }
      const alterOpen = line.match(ALTER_OPEN);
      if (alterOpen) {
        alterTable = alterOpen[1];
        current = null;
        // 单行形态 `ALTER TABLE x ADD COLUMN ...`：在表名之后的余段里找。
        const rest = line.slice(alterOpen[0].length);
        const sameLineAdd = rest.match(ALTER_ADD_COLUMN);
        if (sameLineAdd) {
          columnsOf(alterTable).add(sameLineAdd[1]);
          alterTable = null;
        } else {
          const sameLineDrop = rest.match(ALTER_DROP_COLUMN);
          if (sameLineDrop) {
            columnsOf(alterTable).delete(sameLineDrop[1]);
            alterTable = null;
          }
        }
        continue;
      }
      if (alterTable !== null) {
        const add = line.match(ALTER_ADD_COLUMN);
        if (add) {
          columnsOf(alterTable).add(add[1]);
          continue;
        }
        const drop = line.match(ALTER_DROP_COLUMN);
        if (drop) {
          columnsOf(alterTable).delete(drop[1]);
          continue;
        }
        if (OTHER_STATEMENT.test(line)) alterTable = null;
        continue;
      }
      if (current === null) continue;
      if (TABLE_CLOSE.test(line)) {
        current = null;
        continue;
      }
      if (CONSTRAINT_PREFIX.test(line)) continue;
      const def = line.match(COLUMN_DEF);
      if (def) columnsOf(current).add(def[1]);
    }
  }
  return tables;
}

const SQL_KEYWORD = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WITH|ALTER TABLE)\b/i;
const QUALIFIED_REF = /\b([a-z][a-z0-9_]{2,})\.((?:"[a-zA-Z_][a-zA-Z0-9_]*")|[a-z_][a-z0-9_]*)\b/g;
const INSERT_COLUMNS = /\bINSERT INTO ([a-z0-9_]+)\s*\(([^()]*)\)/gis;
const SOURCE_ALTER_ADD_COLUMN = /\bALTER TABLE (?:IF EXISTS )?([a-z0-9_]+)\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\b/gi;

interface Violation {
  location: string;
  detail: string;
}

function scanSqlText(
  sql: string,
  baseLine: number,
  location: string,
  tables: Map<string, Set<string>>,
  violations: Violation[],
): void {
  const stripped = sql.replace(/\$\{[^}]*\}/g, " ");
  for (const match of stripped.matchAll(SOURCE_ALTER_ADD_COLUMN)) {
    tables.get(match[1])?.add(match[2]);
  }
  for (const match of stripped.matchAll(QUALIFIED_REF)) {
    const columns = tables.get(match[1]);
    if (!columns) continue;
    const column = match[2].replace(/"/g, "");
    if (!columns.has(column)) {
      const line = baseLine + stripped.slice(0, match.index ?? 0).split("\n").length - 1;
      violations.push({ location: `${location}:${line}`, detail: `${match[1]}.${column} 不在该表列定义中` });
    }
  }
  for (const match of stripped.matchAll(INSERT_COLUMNS)) {
    const columns = tables.get(match[1]);
    if (!columns) continue;
    const line = baseLine + stripped.slice(0, match.index ?? 0).split("\n").length - 1;
    for (const raw of match[2].split(",")) {
      const column = raw.trim().replace(/"/g, "");
      if (column && !columns.has(column)) {
        violations.push({ location: `${location}:${line}`, detail: `INSERT INTO ${match[1]} 的列 ${column} 不在该表列定义中` });
      }
    }
  }
}

test("allows a legacy fixture column only after the source file adds it", () => {
  const tables = new Map([["workspace", new Set(["id"])]]);
  const beforeAlter: Violation[] = [];
  const insertLegacyColumn = ["INSERT", " INTO workspace (id, join_code) VALUES ('ws', 'old')"].join("");
  scanSqlText(insertLegacyColumn, 1, "fixture.ts", tables, beforeAlter);
  assert.equal(beforeAlter.length, 1);

  const afterAlter: Violation[] = [];
  const addLegacyColumn = ["ALTER", " TABLE workspace ADD COLUMN join_code TEXT"].join("");
  scanSqlText(addLegacyColumn, 2, "fixture.ts", tables, afterAlter);
  scanSqlText(insertLegacyColumn, 3, "fixture.ts", tables, afterAlter);
  assert.deepEqual(afterAlter, []);
});

test("hand-written SQL references only columns defined in the schema", () => {
  const tables = parseSchemaColumns();
  assert.ok(tables.size >= 100, `应解析出 100+ 张表，实际 ${tables.size}`);
  const violations: Violation[] = [];
  for (const file of listFiles(SOURCE_ROOT)) {
    if (file.startsWith(STATEMENTS_ROOT)) continue;
    const text = readFileSync(file, "utf8");
    const relativePath = relative(SOURCE_ROOT, file);
    const fileTables = new Map(Array.from(tables, ([table, columns]) => [table, new Set(columns)]));
    const snippets = [
      ...Array.from(text.matchAll(/`([^`]*)`/g)),
      ...Array.from(text.matchAll(/"([^"\n]*)"/g)),
    ].filter((match) => SQL_KEYWORD.test(match[1])).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const match of snippets) {
      const baseLine = text.slice(0, match.index ?? 0).split("\n").length;
      scanSqlText(match[1], baseLine, relativePath, fileTables, violations);
    }
  }
  assert.deepEqual(
    violations.map((v) => `${v.location}: ${v.detail}`),
    [],
    `手写 SQL 引用了 schema 中不存在的列（表定义见 postgres-schema/statements/）。\n${violations.map((v) => `${v.location}: ${v.detail}`).join("\n")}`,
  );
});
