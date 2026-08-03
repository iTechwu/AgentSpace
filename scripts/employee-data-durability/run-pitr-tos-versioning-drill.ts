/**
 * PostgreSQL PITR / WAL replay and TOS versioning / provider undelete drill skeleton.
 *
 * This script does not modify production databases or object storage. It checks
 * for designated-environment restore drivers and, when present, records the
 * configured recovery point objective. If the drivers are absent it generates a
 * "skipped" evidence file with the required prerequisites.
 *
 * The actual PITR restore, WAL replay, TOS versioning and provider undelete are
 * the responsibility of ../docker-helm.dofe.ai managed infrastructure; this
 * script only documents the AgentSpace-side acceptance boundary.
 *
 * Usage:
 *   node --experimental-strip-types scripts/employee-data-durability/run-pitr-tos-versioning-drill.ts [output.json]
 *
 * Environment:
 *   DOFE_EAD_PITR_RESTORE_COMMAND     e.g. "pgbackrest restore --set=..."
 *   DOFE_EAD_PITR_TARGET_LSN          target WAL LSN or timestamp
 *   DOFE_EAD_TOS_VERSIONING_ENABLED   true/false
 *   DOFE_EAD_TOS_UNDELETE_COMMAND     e.g. "tos-cli restore-object --bucket ..."
 *   DOFE_EAD_RPO_SECONDS              target RPO in seconds
 *   DOFE_EAD_RTO_SECONDS              target RTO in seconds
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PITR_ENV = ["DOFE_EAD_PITR_RESTORE_COMMAND", "DOFE_EAD_PITR_TARGET_LSN"];
const TOS_ENV = ["DOFE_EAD_TOS_VERSIONING_ENABLED", "DOFE_EAD_TOS_UNDELETE_COMMAND"];

function isTruthy(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function isConfigured(names: string[]): boolean {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

async function main() {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pitrConfigured = isConfigured(PITR_ENV);
  const tosConfigured = isConfigured(TOS_ENV);
  const tosVersioningEnabled = isTruthy("DOFE_EAD_TOS_VERSIONING_ENABLED");

  const evidence = {
    schemaVersion: 1,
    runId,
    checkedAt: new Date().toISOString(),
    status: pitrConfigured && tosConfigured ? "configured" : "skipped",
    reason: pitrConfigured && tosConfigured
      ? "PITR and TOS versioning drivers are configured; actual restore must be executed in the designated environment."
      : "Requires designated-environment restore drivers (DOFE_EAD_PITR_RESTORE_COMMAND, DOFE_EAD_TOS_UNDELETE_COMMAND).",
    objectives: {
      rpoSeconds: Number(process.env.DOFE_EAD_RPO_SECONDS ?? "0") || undefined,
      rtoSeconds: Number(process.env.DOFE_EAD_RTO_SECONDS ?? "0") || undefined,
    },
    pitr: {
      configured: pitrConfigured,
      restoreCommand: process.env.DOFE_EAD_PITR_RESTORE_COMMAND || undefined,
      targetLsn: process.env.DOFE_EAD_PITR_TARGET_LSN || undefined,
    },
    tos: {
      versioningEnabled: tosVersioningEnabled,
      undeleteCommand: process.env.DOFE_EAD_TOS_UNDELETE_COMMAND || undefined,
    },
    requiredAcceptance: [
      "PostgreSQL can be restored to the target LSN/timestamp and replayed to a consistent state.",
      "Restored control-plane row counts for employee/workspace/revision/artifact match expected baseline.",
      "TOS versioning or provider undelete can recover accidentally deleted blobs without data loss.",
      "Restored object SHA-256/size match the revision manifest expectations.",
      `RPO target ${process.env.DOFE_EAD_RPO_SECONDS ?? "unset"}s and RTO target ${process.env.DOFE_EAD_RTO_SECONDS ?? "unset"}s are met or documented as exceptions.`,
    ],
  };

  const outputPath = process.argv[2] || join(rootDir, "docs/0801/employee-data-durability/evidence", `pitr-tos-versioning-drill-${runId}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));

  console.log(`PITR/TOS versioning drill: ${evidence.status}`);
  console.log(`PITR configured: ${pitrConfigured}`);
  console.log(`TOS versioning enabled: ${tosVersioningEnabled}`);
  console.log(`Evidence: ${outputPath}`);
  if (!pitrConfigured || !tosConfigured) {
    console.log("Set the required environment variables in a designated environment to move from skipped to configured.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
