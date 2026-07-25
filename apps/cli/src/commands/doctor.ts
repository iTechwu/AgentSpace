import { existsSync } from "node:fs";
import { join } from "node:path";
import { cwd, version } from "node:process";
import { ensureWorkspaceStateSync, getWorkspaceDatabaseFilePath } from "@dofe-agent/services";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runDoctorCommand(format: OutputFormat): number {
  const rootDir = cwd();

  let databaseConfigured = false;
  let databaseConnectionNote = "PostgreSQL 主库连接串";

  try {
    getWorkspaceDatabaseFilePath();
    databaseConfigured = true;
  } catch (error) {
    databaseConnectionNote = formatErrorNote(error, "缺少 PostgreSQL 主库连接串");
  }

  let workspaceSnapshotReady = false;
  let workspaceSnapshotNote = "workspace snapshot 可读写";
  if (databaseConfigured) {
    try {
      ensureWorkspaceStateSync();
      workspaceSnapshotReady = true;
    } catch (error) {
      workspaceSnapshotNote = formatErrorNote(error, "workspace snapshot 访问失败");
    }
  } else {
    workspaceSnapshotNote = "先配置 SELF_HOSTED_DATABASE_URL、DOFE_AGENT_PG_URL 或 DATABASE_URL";
  }

  const checks = [
    check("Target.md", existsSync(join(rootDir, "Target.md")), "仓库根目录标记"),
    check("apps/web", existsSync(join(rootDir, "apps", "web")), "Web 应用"),
    check("apps/cli", existsSync(join(rootDir, "apps", "cli")), "本地控制 CLI"),
    check("packages/domain", existsSync(join(rootDir, "packages", "domain")), "共享领域模型"),
    check("packages/services", existsSync(join(rootDir, "packages", "services")), "业务逻辑层"),
    check("packages/db", existsSync(join(rootDir, "packages", "db")), "PostgreSQL 持久化层"),
    check("postgres", databaseConfigured, databaseConnectionNote),
    check("workspace_snapshot", workspaceSnapshotReady, workspaceSnapshotNote),
  ];

  const summary = {
    projectRoot: rootDir,
    node: version,
    passedChecks: checks.filter((item) => item.status === "ok").length,
    totalChecks: checks.length,
  };

  if (format === "json") {
    writeData(format, { summary, checks });
    return 0;
  }

  console.log("DofeAgent Doctor");
  console.log("");
  console.log(`root: ${summary.projectRoot}`);
  console.log(`node: ${summary.node}`);
  console.log(`checks: ${summary.passedChecks}/${summary.totalChecks}`);
  console.log("");
  writeData(format, checks);
  return 0;
}

function check(name: string, passed: boolean, note: string) {
  return {
    name,
    status: passed ? "ok" : "missing",
    note,
  };
}

function formatErrorNote(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
