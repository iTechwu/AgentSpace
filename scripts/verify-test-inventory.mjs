import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/;
// The deferred set is existing debt, not default coverage. Hashing the exact
// sorted paths prevents it from growing or changing without explicit review.
// Re-frozen 2026-08-08: the set drifted since fc7e589e as openmontage/workflows/
// cli/db features landed tests outside the default-run allowlists. Reviewed
// additions are real-DB integration tests or files outside package default runs;
// none belong in isDefaultOwned. Re-freezing at the current 174-file set rather
// than reclassifying (which would alter CI for unrelated features).
const EXPECTED_DEFERRED_DIGEST = "0b3ea494e20b8738871596df28a3621e2a3f5465ccfe2fdbda1cc1f9f0203f0f";

function listTestFiles(directory = repositoryRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".next", "data", "node_modules", "temp", "tmp"].includes(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTestFiles(absolutePath));
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      files.push(relative(repositoryRoot, absolutePath));
    }
  }
  return files.sort();
}

function isDefaultOwned(file) {
  if (file.startsWith("apps/web/") && file.includes("/e2e/") && file.includes(".spec.")) return true;
  if (file.startsWith("apps/web/") && file.includes(".test.")) return true;
  if (file.startsWith("apps/mcp-egress-proxy/src/") && file.endsWith(".test.ts")) return true;
  if (file.startsWith("packages/domain/src/") && !file.slice("packages/domain/src/".length).includes("/")) return true;
  if (file.startsWith("packages/sandbox/src/") && file.endsWith(".test.ts")) return true;

  if (
    file.startsWith("packages/services/src/skills/")
    || file.startsWith("packages/services/src/mcp-center/")
    || file.startsWith("packages/services/src/skill-services/")
    || file.startsWith("packages/services/src/openmontage/")
  ) return true;

  if (file.startsWith("packages/daemon/src/skill-install/") || file.startsWith("packages/daemon/src/skill-service/")) {
    return file.endsWith(".test.ts");
  }
  if (/^packages\/daemon\/src\/skill-runner.*\.test\.ts$/.test(file)) return true;
  if (new Set([
    "packages/daemon/src/managed-node-image-contract.test.ts",
    "packages/daemon/src/resumable-transfer.test.ts",
    "packages/daemon/src/runtime-apps.test.ts",
    "packages/daemon/src/skill-environment.test.ts",
    "packages/daemon/src/task-context-skill-env.test.ts",
  ]).has(file)) return true;

  if (new Set([
    "packages/db/src/employee-data-legal-holds.test.ts",
    "packages/db/src/openmontage-jobs.test.ts",
    "packages/db/src/skill-runner-invocations.test.ts",
    "packages/db/src/skill-service-operations.test.ts",
    "packages/db/src/skill-services.test.ts",
  ]).has(file)) return true;

  if (new Set([
    "apps/cli/src/commands/output.test.ts",
    "apps/cli/src/lib/daemon-client.test.ts",
    "apps/cli/src/lib/daemon-task-context.test.ts",
    "deploy/self-hosted/managed-runtime-release-gates.test.mjs",
  ]).has(file)) return true;

  return false;
}

function digestLines(lines) {
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
if (packageJson.scripts?.test !== "turbo run test --concurrency=2") {
  console.error('[verify-test-inventory] Root "test" must remain "turbo run test --concurrency=2".');
  process.exit(1);
}

const allTests = listTestFiles();
const ownedTests = allTests.filter(isDefaultOwned);
const deferredTests = allTests.filter((file) => !isDefaultOwned(file));
const deferredDigest = digestLines(deferredTests);

if (deferredDigest !== EXPECTED_DEFERRED_DIGEST) {
  console.error(
    `[verify-test-inventory] Deferred test inventory changed.\n`
      + `Expected digest: ${EXPECTED_DEFERRED_DIGEST}\n`
      + `Actual digest:   ${deferredDigest}\n`
      + `Deferred files (${deferredTests.length}):\n${deferredTests.map((file) => `  ${file}`).join("\n")}\n`
      + "Assign changed files to a default package test, or consciously update the reviewed deferred digest.",
  );
  process.exit(1);
}

console.log(
  `[verify-test-inventory] ${ownedTests.length} default-owned test file(s); `
    + `${deferredTests.length} explicitly frozen deferred file(s) (${deferredDigest.slice(0, 12)}).`,
);
