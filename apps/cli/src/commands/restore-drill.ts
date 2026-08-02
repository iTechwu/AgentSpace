import { resolvePostgresDatabaseUrl } from "@dofe-agent/db";
import { runBackupRestoreDrillRunSync } from "@dofe-agent/services";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

/**
 * D-10 external-restore drill driver (docs/0801/employee-data-durability/02 §5).
 *
 * Runbook entry point for a PHYSICAL backup/restore drill. It must be executed
 * against a RESTORED database + object-storage snapshot (scratch environment),
 * not the live production database. It:
 *   1. refuses to run when the connected database is the production one,
 *   2. runs the drill against the restored data,
 *   3. records an `external_restore` drill run carrying the PITR restore point,
 *      source snapshot, scratch environment and measured restore duration (RTO),
 *   4. prints the run record as JSON for the external runbook to capture/archive
 *      (the scratch environment may be destroyed afterwards).
 *
 * The PostgreSQL/TOS backup + restore to the scratch environment are performed
 * by the externally managed infrastructure (`docker-helm.dofe.ai`); AgentSpace
 * only verifies the restored snapshot.
 *
 * Usage (runbook):
 *   SELF_HOSTED_DATABASE_URL=<restored-scratch-db-url> \
 *   DOFE_AGENT_PRODUCTION_DATABASE_URL=<production-db-url> \
 *   DOFE_AGENT_RESTORE_DRILL=1 \
 *   dofe-agent restore-drill \
 *     --restore-point-at "2026-08-02T00:00:00Z" \
 *     --source-snapshot "pitr-20260802" \
 *     --restore-environment "scratch-dr-20260802" \
 *     --restore-duration-ms 245000 \
 *     --workspace-id default \
 *     --sample-limit 5 \
 *     --json
 */
export function runRestoreDrillCommand(args: string[], format: OutputFormat): number {
  if (process.env.DOFE_AGENT_RESTORE_DRILL !== "1") {
    console.error(
      "Refusing to run: DOFE_AGENT_RESTORE_DRILL=1 must be set so a restore drill is never triggered by accident.",
    );
    return 1;
  }

  const { flags } = parseArgs(args);
  const restorePointAt = getStringFlag(flags, "restore-point-at");
  const sourceSnapshot = getStringFlag(flags, "source-snapshot");
  const restoreEnvironment = getStringFlag(flags, "restore-environment");
  const restoreDurationMsFlag = getStringFlag(flags, "restore-duration-ms");
  const workspaceId = getStringFlag(flags, "workspace-id") ?? "default";
  const sampleLimitFlag = getStringFlag(flags, "sample-limit");

  const restoreDurationMs = restoreDurationMsFlag ? Number.parseInt(restoreDurationMsFlag, 10) : undefined;
  if (restoreDurationMsFlag && !Number.isFinite(restoreDurationMs)) {
    console.error("--restore-duration-ms must be an integer.");
    return 1;
  }
  const sampleLimit = sampleLimitFlag ? Number.parseInt(sampleLimitFlag, 10) : undefined;

  if (!restorePointAt || !sourceSnapshot || !restoreEnvironment) {
    console.error(
      "Usage: dofe-agent restore-drill --restore-point-at <iso> --source-snapshot <id> "
      + "--restore-environment <id> [--restore-duration-ms <n>] [--workspace-id <id>] [--sample-limit <n>] [--json]",
    );
    return 1;
  }

  // Guard: the connected database must NOT be the production one. A scratch
  // restore is a different database name (e.g. agent_space_restore_<ts>).
  if (isProductionDatabase()) {
    console.error(
      "Refusing to run: the connected database resolves to the production database. "
      + "Point SELF_HOSTED_DATABASE_URL at the RESTORED scratch database and retry.",
    );
    return 1;
  }

  const run = runBackupRestoreDrillRunSync({
    workspaceId,
    sampleLimit,
    trigger: "manual",
    restorePointAt,
    sourceSnapshot,
    restoreEnvironment,
    restoreDurationMs,
  });

  writeData(format, {
    ok: run.status === "completed",
    run,
  });
  return run.status === "completed" ? 0 : 1;
}

function isProductionDatabase(): boolean {
  try {
    const effectiveUrl = resolvePostgresDatabaseUrl();
    // The production database reference is EXPLICITLY separate from the
    // connection the driver points at the restored scratch database. Without it
    // we cannot prove the connected DB is not production, so we fail closed.
    const productionUrl = process.env.DOFE_AGENT_PRODUCTION_DATABASE_URL ?? "";
    if (!productionUrl) {
      console.error(
        "DOFE_AGENT_PRODUCTION_DATABASE_URL must be set so the restore-drill can prove it is not connected to production.",
      );
      return true;
    }
    return databaseNameOf(effectiveUrl) === databaseNameOf(productionUrl);
  } catch {
    // If we cannot resolve, fail closed — never run a physical drill on an
    // environment we cannot prove is a scratch restore.
    return true;
  }
}

function databaseNameOf(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.pathname ?? "").replace(/^\//, "");
  } catch {
    return url;
  }
}
