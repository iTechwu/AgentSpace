/**
 * Designated-environment full control-plane destroy/recovery E2E checklist runner.
 *
 * This script is intentionally a template/checklist driver. It does not destroy
 * containers, volumes, or infrastructure. When run locally without the required
 * env variables it prints the checklist and generates a "skipped" evidence file.
 * When run in a designated environment with all variables set, it records the
 * checklist state and any lightweight validations that can be performed safely.
 *
 * Usage:
 *   node --experimental-strip-types scripts/employee-data-durability/run-designated-e2e-checklist.ts [output.json]
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface ChecklistItem {
  id: string;
  phase: string;
  description: string;
  status: "not_run" | "configured" | "passed" | "failed" | "skipped";
  notes?: string;
}

const REQUIRED_ENV = [
  "DOFE_EAD_DESIGNATED_E2E_ENABLED",
  "DOFE_EAD_WORKSPACE_ID",
  "DOFE_EAD_TARGET_RUNTIME_ID",
  "DOFE_EAD_TARGET_IMAGE_DIGEST",
  "DOFE_EAD_DAEMON_STATE_VOLUME",
  "DOFE_EAD_MANAGED_RUNTIME_API_BASE",
  "DOFE_EAD_PROVIDER_NAME",
  "DOFE_EAD_SECRET_NAME",
  "DOFE_EAD_TEST_EMPLOYEE_NAME",
];

const OPTIONAL_ENV = [
  "DOFE_EAD_MCP_CONNECTION_ID",
  "DOFE_EAD_SKILL_ARTIFACT_DIGEST",
  "DOFE_EAD_SKILL_RELEASE_LOCK_DIGEST",
  "DOFE_EAD_TEST_TASK_ID",
  "DOFE_EAD_TEST_EXPECTED_OUTPUT_PATH",
];

const CHECKLIST: ChecklistItem[] = [
  { id: "baseline-1", phase: "基线记录", description: "记录 workspace head revision ID、manifest digest、去重后总字节数", status: "not_run" },
  { id: "baseline-2", phase: "基线记录", description: "记录所有 bound Skill artifact digest 与 release lock digest", status: "not_run" },
  { id: "baseline-3", phase: "基线记录", description: "记录 Provider credential 名称、Secret 名称和 MCP connection ID", status: "not_run" },
  { id: "baseline-4", phase: "基线记录", description: "记录当前 Runtime image digest、容器 ID 和 Daemon state volume 名称", status: "not_run" },
  { id: "baseline-5", phase: "基线记录", description: "运行一次普通任务并确认成功", status: "not_run" },
  { id: "destroy-1", phase: "控制面销毁", description: "停止旧 Runtime 容器", status: "not_run" },
  { id: "destroy-2", phase: "控制面销毁", description: "删除旧 Runtime 容器", status: "not_run" },
  { id: "destroy-3", phase: "控制面销毁", description: "删除 Daemon state volume", status: "not_run" },
  { id: "destroy-4", phase: "控制面销毁", description: "确认本地节点无残留 workspace blob cache/mount/state", status: "not_run" },
  { id: "rebuild-1", phase: "控制面重建", description: "使用新 image digest 创建全新 Runtime", status: "not_run" },
  { id: "rebuild-2", phase: "控制面重建", description: "重新绑定同一员工到新的 Runtime/binding generation", status: "not_run" },
  { id: "rebuild-3", phase: "控制面重建", description: "触发 rebuild 恢复操作并进入 health_check", status: "not_run" },
  { id: "rebuild-4", phase: "控制面重建", description: "workspace 从 TOS 重新物化并逐文件校验", status: "not_run" },
  { id: "rebuild-5", phase: "控制面重建", description: "Skill artifact 与 release lock 重新安装/校验", status: "not_run" },
  { id: "rebuild-6", phase: "控制面重建", description: "Secret 解密非空且注入 Daemon 环境", status: "not_run" },
  { id: "rebuild-7", phase: "控制面重建", description: "Provider 探针通过", status: "not_run" },
  { id: "rebuild-8", phase: "控制面重建", description: "MCP verify operation 完成且成功", status: "not_run" },
  { id: "rebuild-9", phase: "控制面重建", description: "operation 完成 head CAS、generation CAS 与不可变审计", status: "not_run" },
  { id: "verify-1", phase: "恢复后验证", description: "恢复后的 Runtime 运行真实任务并成功", status: "not_run" },
  { id: "verify-2", phase: "恢复后验证", description: "任务输出文件路径/大小/SHA-256 与预期一致", status: "not_run" },
  { id: "verify-3", phase: "恢复后验证", description: "新任务提交产生新 revision 且 head 正确推进", status: "not_run" },
  { id: "verify-4", phase: "恢复后验证", description: "旧 worker attempt 因 generation fencing 被拒绝", status: "not_run" },
  { id: "verify-5", phase: "恢复后验证", description: "legal hold、retention quota 与 lifecycle 规则生效", status: "not_run" },
  { id: "evidence-1", phase: "证据与回滚", description: "保存 designated-e2e-checklist 证据 JSON", status: "not_run" },
];

function isEnabled(): boolean {
  return process.env.DOFE_EAD_DESIGNATED_E2E_ENABLED?.trim().toLowerCase() === "true";
}

function missingRequired(): string[] {
  return REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
}

async function runLightweightValidations(items: ChecklistItem[]): Promise<void> {
  // Validate that required env vars are present. This is the only safe automated
  // check the template performs; actual container/volume operations must be run
  // by a human operator or a designated-environment automation with proper guards.
  const missing = missingRequired();
  if (missing.length > 0) {
    for (const item of items) {
      item.status = "skipped";
      item.notes = `Missing required environment variables: ${missing.join(", ")}`;
    }
    return;
  }

  for (const item of items) {
    if (item.id.startsWith("baseline-")) {
      item.status = "configured";
      item.notes = "Values sourced from environment; operator must confirm against live control plane.";
    } else if (item.id.startsWith("destroy-")) {
      item.status = "skipped";
      item.notes = "Destroy steps are intentionally manual/operator-driven in designated environments.";
    } else if (item.id.startsWith("rebuild-")) {
      item.status = "skipped";
      item.notes = "Rebuild steps require live runtime-provisioning and recovery worker coordination.";
    } else if (item.id.startsWith("verify-")) {
      item.status = "skipped";
      item.notes = "Verification steps require successful rebuild and task execution.";
    } else if (item.id === "evidence-1") {
      item.status = "passed";
      item.notes = "This evidence file is the artifact of the checklist runner.";
    }
  }
}

async function main() {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const enabled = isEnabled();
  const missing = missingRequired();
  const items = CHECKLIST.map((item) => ({ ...item }));

  if (enabled && missing.length === 0) {
    await runLightweightValidations(items);
  } else {
    for (const item of items) {
      item.status = "skipped";
      item.notes = enabled
        ? `Missing required environment variables: ${missing.join(", ")}`
        : "DOFE_EAD_DESIGNATED_E2E_ENABLED is not set to true.";
    }
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    checkedAt: new Date().toISOString(),
    status: enabled && missing.length === 0 ? "configured" : "skipped",
    enabled,
    missingRequired: missing,
    environment: {
      required: Object.fromEntries(REQUIRED_ENV.map((name) => [name, process.env[name] ? "<set>" : "<missing>"])),
      optional: Object.fromEntries(OPTIONAL_ENV.map((name) => [name, process.env[name] ? "<set>" : "<missing>"])),
    },
    checklist: items,
    passCriteria: "所有 verify-* 项为 passed，且 destroy/rebuild 阶段由指定环境操作完成并记录证据。",
  };

  const outputPath = process.argv[2] || join(rootDir, "docs/0801/employee-data-durability/evidence", `designated-e2e-checklist-${runId}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));

  console.log(`Designated E2E checklist: ${evidence.status}`);
  console.log(`Run ID: ${runId}`);
  if (missing.length > 0) {
    console.log(`Missing required env: ${missing.join(", ")}`);
  }
  console.log(`Evidence: ${outputPath}`);
  console.log("\nChecklist:");
  for (const item of items) {
    console.log(`[${item.status}] ${item.phase} - ${item.description}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
