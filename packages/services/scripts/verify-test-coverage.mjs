// Verifies the services package test script's glob coverage never silently
// drops a test file (docs/0803 gap review, P0-1).
//
// The `test` script runs one node process per file, one file at a time, over
// the directories claimed below. A new *.test.ts added anywhere under these
// directories MUST be executed by that script; if a glob misses it, this guard
// fails the run before any test executes.
//
// Test files outside the claimed directories (e.g. Feishu integration suites)
// are intentionally not run by the services test script; they are reported so
// coverage scope stays visible, but do not fail the gate.

import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every *.test.ts under one of these prefixes must be matched by a glob in the
// `test` script in package.json.
const COVERED_PREFIXES = ["src/skills", "src/mcp-center", "src/skill-services", "src/workflows"];
// The exact globs used by the `test` script. Keep in sync with package.json.
const COVERED_GLOBS = [
  "src/skills/*.test.ts",
  "src/skills/package/*.test.ts",
  "src/mcp-center/*.test.ts",
  "src/skill-services/*.test.ts",
  "src/workflows/*.test.ts",
];

function globToRegex(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
}

function expandGlob(glob) {
  const starIndex = glob.indexOf("*");
  const dir = starIndex >= 0 ? glob.slice(0, glob.lastIndexOf("/")) : glob;
  const fullDir = join(packageRoot, dir);
  if (!existsSync(fullDir)) {
    return [];
  }
  const regex = globToRegex(glob);
  return readdirSync(fullDir)
    .filter((name) => regex.test(`${dir}/${name}`))
    .map((name) => `${dir}/${name}`);
}

function allTestFiles() {
  const result = [];
  const walk = (relDir) => {
    const fullDir = join(packageRoot, relDir);
    for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.name.endsWith(".test.ts")) {
        result.push(rel);
      }
    }
  };
  walk("src");
  return result;
}

const matchedByGlobs = new Set(COVERED_GLOBS.flatMap(expandGlob));
const allFiles = allTestFiles();

let failed = false;

// 1. A test file under a claimed directory must be matched by a test-script glob.
const uncoveredInCovered = allFiles.filter(
  (file) => COVERED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !matchedByGlobs.has(file),
);
if (uncoveredInCovered.length > 0) {
  console.error(
    `[verify-test-coverage] Test files under claimed directories are not run by the test script:\n${uncoveredInCovered
      .map((file) => `  ${file}`)
      .join("\n")}\nAdd a matching glob to packages/services/package.json "test".`,
  );
  failed = true;
}

// 2. Every claimed glob must expand to at least one test file (guards stale paths).
for (const glob of COVERED_GLOBS) {
  if (!matchedByGlobs.has(glob) && expandGlob(glob).length === 0) {
    console.error(`[verify-test-coverage] Glob "${glob}" matches no test file; path may be stale.`);
    failed = true;
  }
}

const uncovered = allFiles.filter((file) => !COVERED_PREFIXES.some((prefix) => file.startsWith(prefix)));
console.log(
  `[verify-test-coverage] ${matchedByGlobs.size} test file(s) under ${COVERED_PREFIXES.join(
    ", ",
  )}; ${uncovered.length} outside claimed coverage (not run here).`,
);
if (uncovered.length > 0) {
  console.log(`  outside coverage: ${uncovered.join(", ")}`);
}

if (failed) {
  process.exit(1);
}
