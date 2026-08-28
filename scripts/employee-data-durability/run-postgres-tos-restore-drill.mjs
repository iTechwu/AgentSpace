import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAttachmentStorageClient } from "../../packages/services/src/attachments/storage.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const safeRunId = runId.replaceAll("-", "_");
const scratchDatabase = `dofe_ead_drill_${safeRunId}`.slice(0, 63);
const dumpPath = `/tmp/dofe_ead_drill_${safeRunId}.dump`;
const evidencePath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repositoryRoot, "docs/0801/employee-data-durability/evidence", `d10-${runId}.json`);
const postgresContainer = process.env.DOFE_EAD_POSTGRES_CONTAINER?.trim() || "dofe-postgres";
const databaseUrl = process.env.DOFE_AGENT_TEST_DATABASE_URL?.trim()
  || process.env.DOFE_AGENT_PG_TEST_URL?.trim()
  || "";
if (!databaseUrl) throw new Error("D-10 requires DOFE_AGENT_TEST_DATABASE_URL or DOFE_AGENT_PG_TEST_URL.");
const parsedDatabaseUrl = new URL(databaseUrl);
const sourceDatabase = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ""));
const databaseUser = decodeURIComponent(parsedDatabaseUrl.username);
const databasePassword = decodeURIComponent(parsedDatabaseUrl.password);
if (!/(^|[_-])(test|e2e|loadtest)([_-]|$)/i.test(sourceDatabase) && process.env.DOFE_EAD_ALLOW_NON_TEST_SOURCE !== "1") {
  throw new Error(`Refusing D-10 against non-test database "${sourceDatabase}".`);
}
if (!/^dofe_ead_drill_[a-z0-9_]+$/.test(scratchDatabase)) throw new Error("Unsafe scratch database name.");

const evidence = {
  schemaVersion: 1,
  drill: "D-10",
  runId,
  status: "running",
  checkedAt: "",
  postgres: {
    method: "pg_dump_custom_archive_restore",
    sourceDatabase,
    scratchDatabase,
    container: postgresContainer,
    restorePointAt: "",
    sourceWalLsn: "",
    dumpSizeBytes: 0,
    archiveEntries: 0,
    sourceCounts: {},
    restoredCounts: {},
    sourceCountsDigest: "",
    restoredCountsDigest: "",
    durationMs: 0,
    pitrValidated: false,
    scratchDatabaseRemoved: false,
  },
  tos: {
    method: "scratch_prefix_backup_delete_restore",
    sourceKey: "",
    backupKey: "",
    bucket: "",
    endpoint: "",
    sha256: "",
    sizeBytes: 0,
    sourceDeletionObserved: false,
    restoredDigestVerified: false,
    scratchObjectsRemoved: false,
    versioningValidated: false,
  },
  assertions: {},
  limitations: [
    "PostgreSQL PITR/WAL replay was not exercised; this drill uses a consistent custom-format pg_dump restored into an isolated scratch database.",
    "TOS bucket versioning and provider-side undelete were not exercised; this drill restores a deleted source object from a task-owned backup prefix.",
  ],
};

let scratchCreated = false;
const createdTosObjects = [];

function runDocker(args, options = {}) {
  const result = spawnSync(process.env.DOCKER_BIN?.trim() || "docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 300_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = `${result.stderr || result.stdout || result.error?.message || "unknown error"}`
      .replaceAll(databasePassword, "***")
      .trim();
    throw new Error(`${options.label || "docker command"} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function postgresTool(tool, args, label) {
  return runDocker([
    "exec",
    "-e", `PGPASSWORD=${databasePassword}`,
    postgresContainer,
    tool,
    "-h", "127.0.0.1",
    "-p", "5432",
    "-U", databaseUser,
    ...args,
  ], { label });
}

function queryJson(database, sql) {
  return JSON.parse(postgresTool("psql", ["-d", database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], "PostgreSQL query"));
}

function countsQuery() {
  return `SELECT json_build_object(
    'workspace', (SELECT COUNT(*) FROM workspace),
    'employee', (SELECT COUNT(*) FROM workspace_employee),
    'task', (SELECT COUNT(*) FROM agent_task_queue),
    'revision', (SELECT COUNT(*) FROM employee_workspace_revision),
    'artifact', (SELECT COUNT(*) FROM employee_artifact),
    'contentBlob', (SELECT COUNT(*) FROM content_blob),
    'skillArtifact', (SELECT COUNT(*) FROM skill_artifact),
    'legalHold', (SELECT COUNT(*) FROM employee_data_legal_hold),
    'auditLog', (SELECT COUNT(*) FROM audit_log),
    'schemaVersion', COALESCE((SELECT value FROM app_metadata WHERE key = 'postgres_schema_version'), '')
  )`;
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toStorageReadInput(object) {
  if (!object.key) throw new Error("TOS object key is missing.");
  return {
    storageProvider: object.provider,
    storageBucket: object.bucket,
    storageRegion: object.region,
    storageEndpoint: object.endpoint,
    storageKey: object.key,
    storedPath: object.storedPath,
  };
}

function assertOwnedTosObject(object) {
  const expectedPrefix = `workspaces/ead-d10-drill-${runId}/attachments/`;
  const relativeKey = object.key?.startsWith(expectedPrefix) ? object.key.slice(expectedPrefix.length) : "";
  if (!/^\d{4}\/\d{2}\/ead-d10-(?:source|backup)-[a-z0-9-]+\/physical-restore\.bin$/.test(relativeKey)) {
    throw new Error(`Refusing to mutate non-drill TOS object "${object.key || "missing"}".`);
  }
}

function writeEvidence(error) {
  evidence.checkedAt = new Date().toISOString();
  evidence.error = error;
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

try {
  const startedAt = Date.now();
  const sourcePosition = queryJson(sourceDatabase, "SELECT json_build_object('restorePointAt', clock_timestamp(), 'walLsn', pg_current_wal_lsn())");
  evidence.postgres.restorePointAt = sourcePosition.restorePointAt;
  evidence.postgres.sourceWalLsn = sourcePosition.walLsn;
  evidence.postgres.sourceCounts = queryJson(sourceDatabase, countsQuery());
  evidence.postgres.sourceCountsDigest = digestJson(evidence.postgres.sourceCounts);

  postgresTool("pg_dump", ["-d", sourceDatabase, "--format=custom", "--compress=6", "--file", dumpPath], "PostgreSQL dump");
  evidence.postgres.dumpSizeBytes = Number(runDocker(["exec", postgresContainer, "stat", "-c", "%s", dumpPath], { label: "dump stat" }));
  evidence.postgres.archiveEntries = postgresTool("pg_restore", ["--list", dumpPath], "archive listing")
    .split("\n").filter((line) => /^\d+;/.test(line)).length;
  postgresTool("createdb", ["--template=template0", scratchDatabase], "scratch database create");
  scratchCreated = true;
  postgresTool("pg_restore", ["--dbname", scratchDatabase, "--no-owner", "--no-privileges", "--exit-on-error", dumpPath], "scratch database restore");
  evidence.postgres.restoredCounts = queryJson(scratchDatabase, countsQuery());
  evidence.postgres.restoredCountsDigest = digestJson(evidence.postgres.restoredCounts);
  evidence.postgres.durationMs = Date.now() - startedAt;
  if (evidence.postgres.sourceCountsDigest !== evidence.postgres.restoredCountsDigest) {
    throw new Error("Restored PostgreSQL control-plane counts differ from the source dump snapshot.");
  }

  const storage = createAttachmentStorageClient();
  const workspaceId = `ead-d10-drill-${runId}`;
  const sourceInput = {
    workspaceId,
    attachmentId: `ead-d10-source-${runId}`,
    fileName: "physical-restore.bin",
    contentBytes: Buffer.from(`D-10 TOS physical restore ${runId}\n`, "utf8"),
    mediaType: "application/octet-stream",
  };
  const sourceObject = await storage.putObject(sourceInput);
  createdTosObjects.push(sourceObject);
  assertOwnedTosObject(sourceObject);
  const sourceBytes = await storage.getObject(toStorageReadInput(sourceObject));
  const backupObject = await storage.putObject({
    ...sourceInput,
    attachmentId: `ead-d10-backup-${runId}`,
    contentBytes: sourceBytes,
  });
  createdTosObjects.push(backupObject);
  assertOwnedTosObject(backupObject);
  await storage.deleteObject(toStorageReadInput(sourceObject));
  evidence.tos.sourceDeletionObserved = (await storage.headObject(toStorageReadInput(sourceObject))) === null;
  if (!evidence.tos.sourceDeletionObserved) throw new Error("TOS source deletion was not observable.");
  const backupBytes = await storage.getObject(toStorageReadInput(backupObject));
  const restoredObject = await storage.putObject({ ...sourceInput, contentBytes: backupBytes });
  const restoredBytes = await storage.getObject(toStorageReadInput(restoredObject));
  const restoredDigest = createHash("sha256").update(restoredBytes).digest("hex");
  evidence.tos.sourceKey = sourceObject.key || "";
  evidence.tos.backupKey = backupObject.key || "";
  evidence.tos.bucket = sourceObject.bucket || "";
  evidence.tos.endpoint = sourceObject.endpoint || "";
  evidence.tos.sha256 = sourceObject.sha256;
  evidence.tos.sizeBytes = sourceObject.sizeBytes;
  evidence.tos.restoredDigestVerified = restoredDigest === sourceObject.sha256 && restoredBytes.byteLength === sourceObject.sizeBytes;
  if (!evidence.tos.restoredDigestVerified) throw new Error("Restored TOS object digest or size mismatch.");

  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const object of createdTosObjects) {
    try {
      assertOwnedTosObject(object);
      const storage = createAttachmentStorageClient();
      await storage.deleteObject(toStorageReadInput(object));
    } catch (error) {
      evidence.cleanupFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (createdTosObjects.length > 0) {
    const storage = createAttachmentStorageClient();
    evidence.tos.scratchObjectsRemoved = (await Promise.all(
      createdTosObjects.map((object) => storage.headObject(toStorageReadInput(object))),
    )).every((metadata) => metadata === null);
  }
  try {
    if (scratchCreated) postgresTool("dropdb", ["--if-exists", "--force", scratchDatabase], "scratch database drop");
    evidence.postgres.scratchDatabaseRemoved = true;
  } catch (error) {
    evidence.cleanupFailure = error instanceof Error ? error.message : String(error);
  }
  try {
    runDocker(["exec", postgresContainer, "rm", "-f", dumpPath], { label: "dump cleanup" });
  } catch (error) {
    evidence.cleanupFailure = error instanceof Error ? error.message : String(error);
  }
  evidence.assertions = {
    postgresArchiveNonEmpty: evidence.postgres.dumpSizeBytes > 0 && evidence.postgres.archiveEntries > 0,
    postgresRestoredCountsMatch: evidence.postgres.sourceCountsDigest === evidence.postgres.restoredCountsDigest,
    postgresScratchRemoved: evidence.postgres.scratchDatabaseRemoved,
    tosSourceDeletionObserved: evidence.tos.sourceDeletionObserved,
    tosRestoredDigestVerified: evidence.tos.restoredDigestVerified,
    tosScratchObjectsRemoved: evidence.tos.scratchObjectsRemoved,
  };
  if (Object.values(evidence.assertions).some((value) => value !== true) || evidence.cleanupFailure) {
    evidence.status = "failed";
  }
  writeEvidence(evidence.status === "failed" ? evidence.failure || evidence.cleanupFailure || "D-10 assertion failed" : undefined);
}

process.stdout.write(`${JSON.stringify({ status: evidence.status, runId, evidencePath, assertions: evidence.assertions })}\n`);
if (evidence.status !== "passed") process.exitCode = 1;
