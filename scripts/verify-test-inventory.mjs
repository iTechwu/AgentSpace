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
//
// Re-frozen 2026-08-08 (round 2, 175-file set): added
// packages/db/src/postgres-pg-pg-migrate.test.ts — real-PG integration test for
// PG→PG migrate dry-run forward-guard + CLI skip exit code. Same deferred class
// as postgres-background-backfill / postgres-schema-version-guard (not in the db
// default-run glob). Reviewed and kept deferred.
// Re-frozen 2026-08-13 (round 3, 176-file set): added
// packages/services/src/attachments/storage-tos.integration.test.ts — real-TOS integration
// regression baseline for the tos-sdk(axios)/curl dual transport (needs TOS_* env; skips
// cleanly without it). Same deferred class as real-PG integration tests.
// Re-frozen 2026-08-14: added scripts/audit-node-engines.test.mjs — engines 审计
// 回归测试（--root 夹具仓库 + 真实仓库回归锚点）。scripts/ 根目录不属于任何
// workspace 包的默认测试运行，与 deploy/ 脚本测试同属 deferred 类；以
// `node --test scripts/audit-node-engines.test.mjs` 单独执行。
// Re-frozen 2026-08-14 (round 4, 182-file set): promoted
// packages/services/src/{messages/messages,notifications/notifications,channel-access/channel-access}.test.ts
// to default-owned — services package test script now runs them
// (channel-access/notifications 4/4+2/2 pass unconditionally; messages 27/27 pass
// + 14 runtime-dependent cases gated by MANAGED_RUNTIME_AVAILABLE=1, default skip).
// Re-frozen 2026-08-15: promoted shared/audit.test.ts and the new
// prisma-read-cutovers.test.ts into the services default test command. Both are
// classified default-owned below, reducing the reviewed deferred set to 181.
// Re-frozen 2026-08-15 (round 6, 179-file set): promoted 8 Phase 2 cutover
// unit tests (audit-log/notifications/task-execution-events/workspace-memberships/
// employees-runtime-bindings/task-queue/agent-skills/knowledge-proposals — both pg
// 原型 + Prisma 真接入) into the db default test command via the regex rule
// above. Reviewed and confirmed all 8 belong in default coverage; deferred set
// shrinks to 179.
// Re-frozen 2026-08-17 (round 7, 185-file set): promoted
// apps/cli/src/lib/{task-completion-outbox,task-completion-token-usage}.test.ts —
// 两者一直在 cli 包默认测试脚本中显式执行（5 文件清单），但 inventory 的
// default-owned 集漏记（3.6-4 双维护不一致）。补记归位，消除「脚本跑而
// inventory 记 deferred」的矛盾。（核对说明：round 6 注释中的「179」为
// 笔误/漂移，上一版 digest 23fdb8fd 实际对应 187 个文件；本版 187-2=185。）
// Re-frozen 2026-08-17 (round 8, 169-file set): promoted
// packages/services/src/{documents,employees,knowledge}/*.test.ts (16 files)
// into the services default test command (3.3-8 收尾). Deferred set 185-16=170
// (三域 16 文件中 1 个先前已由其他规则覆盖，实际移出 15)。
// Re-frozen 2026-08-17 (round 9, 171-file set): promoted
// apps/cli/src/commands/{integrations,daemon}.test.ts into the cli default
// test script (3.6-2). Prereq fixes: daemon-task-output.ts 改指 daemon src
// （dist 内联 services 附件存储代码，测试 mock 注入对 dist 副本失效）；
// daemon-task-context.test.ts 注入内存 TOS 夹具（此前 reset 会按 --env-file
// 真实 TOS 配置发起远端删除，本地 403）。Deferred 173-2=171。
// Re-frozen 2026-08-20 (session-split round): promoted
// packages/db/src/{conversations,conversation-flags}.test.ts and
// packages/services/src/conversations/conversations.test.ts to default-owned —
// all three are now in the db/services package default test commands (docs/0820
// session-split). Deferred set shrinks by 3.
const EXPECTED_DEFERRED_DIGEST = "08f3bc5c0526a91a904a2f7e8b1cff3a1e6382d4eeb387d883698b2620458a02";

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
    // tos-signer.test.ts（golden vector 单测，无外部凭据）在 services 包默认
    // 测试脚本中显式执行，属 default-owned；2026-08-14 归类修复——此前它使
    // deferred 摘要漂移（唯一新增延迟文件），按 184 文件冻结集恢复一致。
    "packages/services/src/attachments/tos-signer.test.ts",
  ]).has(file)) return true;

  if (new Set([
    "packages/db/src/employee-data-legal-holds.test.ts",
    "packages/db/src/openmontage-jobs.test.ts",
    "packages/db/src/postgres-alias-drift-guard.test.ts",
    "packages/db/src/skill-runner-invocations.test.ts",
    "packages/db/src/skill-service-operations.test.ts",
    "packages/db/src/skill-services.test.ts",
    // session-split（docs/0820）：conversations/conversation-flags 已纳入 db 包默认
    // 测试脚本（src/conversations.test.ts src/conversation-flags.test.ts），属 default-owned。
    "packages/db/src/conversations.test.ts",
    "packages/db/src/conversation-flags.test.ts",
  ]).has(file)) return true;

  // packages/db/src/prisma/*.test.ts — Phase 2 read-cutover runner unit tests
  // run via the db package default test script (glob src/prisma/*.test.ts);
  // matches the packages/domain/src/ top-level rule pattern.
  if (file.startsWith("packages/db/src/prisma/") && !file.slice("packages/db/src/prisma/".length).includes("/") && file.endsWith(".test.ts")) return true;

  // packages/services/src/{messages,notifications,channel-access}/*.test.ts —
  // run via the services package default test script (explicit file list);
  // matches the packages/domain/src/ top-level rule pattern.
  for (const prefix of [
    "packages/services/src/messages/",
    "packages/services/src/notifications/",
    "packages/services/src/channel-access/",
    // 3.3-8 收尾：documents/employees/knowledge 三域纳入 services 默认测试
    // 脚本（glob src/{documents,employees,knowledge}/*.test.ts）。
    "packages/services/src/documents/",
    "packages/services/src/employees/",
    "packages/services/src/knowledge/",
    // session-split（docs/0820）：conversations/conversations.test.ts 已纳入 services 包
    // 默认测试脚本，属 default-owned。
    "packages/services/src/conversations/",
  ]) {
    if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/") && file.endsWith(".test.ts")) {
      return true;
    }
  }

  if (new Set([
    "packages/services/src/prisma-read-cutovers.test.ts",
    "packages/services/src/prisma-write-cutovers.test.ts",
    "packages/services/src/shared/audit.test.ts",
  ]).has(file)) return true;

  // packages/db/src/prisma/{knowledge-proposals,task-queue,agent-skills,
  // employees-runtime-bindings,audit-log,notifications,task-execution-events,
  // workspace-memberships,read-cutover,prisma-client,cutover-runner,
  // audit-log-prisma,audit-log-prisma-write}-*.test.ts — Phase 2 cutover
  // unit tests run via db package default test script (glob src/prisma/*.test.ts
  // already captures *.test.ts directly under src/prisma/). The rule below is
  // redundant with the glob above but kept explicit for future tests that
  // might land in subdirectories.
  if (/^packages\/db\/src\/prisma\/[a-z][a-z0-9._-]*\.test\.ts$/.test(file)) return true;

  if (new Set([
    "apps/cli/src/commands/output.test.ts",
    "apps/cli/src/lib/daemon-client.test.ts",
    "apps/cli/src/lib/daemon-task-context.test.ts",
    // cli 包默认测试脚本还显式执行以下两个文件（见 apps/cli/package.json），
    // 2026-08-17 补记以消除脚本/inventory 双维护不一致（3.6-4）。
    "apps/cli/src/lib/task-completion-outbox.test.ts",
    "apps/cli/src/lib/task-completion-token-usage.test.ts",
    // 3.6-2（2026-08-17）：integrations/daemon 两个大文件入 cli 默认脚本。
    // 前置修复：dofe-agent-daemon dist 内联 services 附件存储代码导致
    // setAttachmentStorageClientForTests 对 loadTaskOutputEnvelope 失效
    // （daemon-task-output.ts 改指 daemon src，同仓库既有惯例）；
    // daemon-task-context.test.ts 补注入内存 TOS 夹具，消除真实远端删除。
    "apps/cli/src/commands/integrations.test.ts",
    "apps/cli/src/commands/daemon.test.ts",
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
