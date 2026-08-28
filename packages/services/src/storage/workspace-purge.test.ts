import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenMontageDelegationIntentSync,
  createWorkspaceSync,
  getDatabase,
  getDaemonWorkspaceExecutionRootDir,
  getLocalDaemonStateDirPath,
  getWorkspaceDataDirPath,
  replaceStoredAttachmentsSync,
  readWorkspaceSync,
  writeWorkspaceStateRecordSync,
} from "@dofe-agent/db";
import {
  persistWorkspaceAttachmentFromBytesSync,
  setAttachmentStorageClientForTests,
  type AttachmentStorageClient,
} from "../index.ts";
import { purgeWorkspaceStorageSync } from "./workspace-purge.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-workspace-purge-"));
const tosObjects = new Map<string, Uint8Array>();
const testTosStorage: AttachmentStorageClient = {
  async putObject(input) { return this.putObjectSync(input); },
  putObjectSync(input) {
    const key = `workspaces/${input.workspaceId}/attachments/${input.attachmentId}/${input.fileName}`;
    const bytes = new Uint8Array(input.contentBytes);
    tosObjects.set(key, bytes);
    return {
      provider: "tos",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: "https://tos-cn-beijing.volces.com",
      key,
      storedPath: `tos://test-bucket/${key}`,
      sizeBytes: bytes.byteLength,
      sha256: "test-sha256",
    };
  },
  async getObject(input) { return this.getObjectSync(input); },
  getObjectSync(input) {
    const bytes = tosObjects.get(input.storageKey ?? "");
    if (!bytes) throw new Error(`NoSuchKey: ${input.storageKey ?? ""}`);
    return new Uint8Array(bytes);
  },
  async headObject() { return null; },
  async deleteObject(input) { tosObjects.delete(input.storageKey ?? ""); },
  deleteObjectSync(input) { tosObjects.delete(input.storageKey ?? ""); },
  async createReadUrl() { return null; },
};

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec(`
    DELETE FROM openmontage_delegation_intent;
    DELETE FROM attachment;
    DELETE FROM task_message;
    DELETE FROM task_execution_event;
    DELETE FROM token_usage;
    DELETE FROM agent_router_event;
    DELETE FROM agent_router_context_snapshot;
    DELETE FROM agent_task_attempt;
    DELETE FROM agent_router_provider_session;
    DELETE FROM agent_task_queue;
    DELETE FROM agent_router_session;
    DELETE FROM employee_runtime_binding;
    DELETE FROM agent_runtime;
    DELETE FROM daemon_api_token;
    DELETE FROM daemon_connection;
    DELETE FROM budget;
    DELETE FROM skill_import_event;
    DELETE FROM agent_skill;
    DELETE FROM agent_knowledge_page;
    DELETE FROM knowledge_page_assignment_policy;
    DELETE FROM skill_file;
    DELETE FROM skill;
    DELETE FROM workspace_task;
    DELETE FROM workspace_channel;
    DELETE FROM workspace_employee;
    DELETE FROM workspace_membership;
    DELETE FROM workspace_snapshot;
    DELETE FROM workspace;
  `);
  rmSync(join(tempRoot, "data", "workspaces"), { recursive: true, force: true });
  rmSync(join(tempRoot, "data", "daemon"), { recursive: true, force: true });
});

test("purgeWorkspaceStorageSync removes workspace db rows, workspace files, and daemon execution roots", () => {
  const purgeTarget = createWorkspaceSync({
    id: "workspace-purge",
    slug: "workspace-purge",
    name: "Purge Target",
    createdBy: "system",
  });
  const survivor = createWorkspaceSync({
    id: "workspace-keep",
    slug: "workspace-keep",
    name: "Keep Workspace",
    createdBy: "system",
  });

  seedWorkspaceRecords(purgeTarget.id, "purge");
  seedWorkspaceRecords(survivor.id, "keep");
  const purgeAttachment = seedWorkspaceAttachment(purgeTarget.id, "purge.txt", "purge me");
  const survivorAttachment = seedWorkspaceAttachment(survivor.id, "keep.txt", "keep me");

  const purgeWorkspaceDir = getWorkspaceDataDirPath(purgeTarget.id);
  const purgeDaemonDir = getDaemonWorkspaceExecutionRootDir(getLocalDaemonStateDirPath(), purgeTarget.id);
  const survivorWorkspaceDir = getWorkspaceDataDirPath(survivor.id);
  const survivorDaemonDir = getDaemonWorkspaceExecutionRootDir(getLocalDaemonStateDirPath(), survivor.id);

  mkdirSync(join(purgeWorkspaceDir, "channel-history"), { recursive: true });
  writeFileSync(join(purgeWorkspaceDir, "channel-history", "general.md"), "# Purge", "utf8");
  mkdirSync(join(purgeDaemonDir, "workdirs", "queue-purge"), { recursive: true });
  writeFileSync(join(purgeDaemonDir, "workdirs", "queue-purge", "agent-output.json"), "{}", "utf8");

  mkdirSync(join(survivorDaemonDir, "workdirs", "queue-keep"), { recursive: true });
  writeFileSync(join(survivorDaemonDir, "workdirs", "queue-keep", "agent-output.json"), "{}", "utf8");

  const result = purgeWorkspaceStorageSync(purgeTarget.id);

  assert.equal(result.workspaceId, purgeTarget.id);
  assert.equal(result.db.deletedWorkspace, true);
  assert.equal(result.removedAttachmentObjectCount, 1);
  assert.equal(tosObjects.has(purgeAttachment.storageKey ?? ""), false);
  assert.equal(tosObjects.has(survivorAttachment.storageKey ?? ""), true);
  assert.equal(result.db.removedAgentRouterSessionRows, 1);
  assert.equal(result.db.removedAgentRouterProviderSessionRows, 1);
  assert.equal(result.db.removedAgentTaskAttemptRows, 1);
  assert.equal(result.db.removedAgentRouterEventRows, 1);
  assert.equal(result.db.removedAgentRouterContextSnapshotRows, 1);
  assert.equal(readWorkspaceSync(purgeTarget.id), null);
  assert.equal(existsSync(purgeWorkspaceDir), false);
  assert.equal(existsSync(purgeDaemonDir), false);
  assert.equal(countWhere(getDatabase(), "agent_router_session", "workspace_id", purgeTarget.id), 0);
  assert.equal(countWhere(getDatabase(), "agent_router_provider_session", "workspace_id", purgeTarget.id), 0);
  assert.equal(countWhere(getDatabase(), "agent_task_attempt", "workspace_id", purgeTarget.id), 0);
  assert.equal(countWhere(getDatabase(), "agent_router_event", "workspace_id", purgeTarget.id), 0);
  assert.equal(countWhere(getDatabase(), "agent_router_context_snapshot", "workspace_id", purgeTarget.id), 0);

  assert.notEqual(readWorkspaceSync(survivor.id), null);
  assert.equal(existsSync(survivorWorkspaceDir), true);
  assert.equal(existsSync(survivorDaemonDir), true);
  assert.equal(countWhere(getDatabase(), "agent_router_session", "workspace_id", survivor.id), 1);
  assert.equal(countWhere(getDatabase(), "agent_router_provider_session", "workspace_id", survivor.id), 1);
  assert.equal(countWhere(getDatabase(), "agent_task_attempt", "workspace_id", survivor.id), 1);
  assert.equal(countWhere(getDatabase(), "agent_router_event", "workspace_id", survivor.id), 1);
  assert.equal(countWhere(getDatabase(), "agent_router_context_snapshot", "workspace_id", survivor.id), 1);
});

test("purgeWorkspaceStorageSync keeps files and attachments when OpenMontage audit evidence blocks purge", () => {
  const workspace = createWorkspaceSync({
    id: "workspace-openmontage-preserved",
    slug: "workspace-openmontage-preserved",
    name: "OpenMontage Preserved",
    createdBy: "system",
  });
  const attachment = seedWorkspaceAttachment(workspace.id, "billing.txt", "preserve me");
  const workspaceDir = getWorkspaceDataDirPath(workspace.id);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "billing.txt"), "preserve me", "utf8");
  createOpenMontageDelegationIntentSync({
    idempotencyKey: "intent-storage-purge-guard",
    workspaceId: workspace.id,
    runtimeId: "runtime-1",
    mcpConnectionId: "mcp-1",
    runtimeCredentialId: "credential-1",
    modelsTenantId: "tenant-1",
    modelsTeamId: "team-1",
    externalJobId: "job-1",
    request: {
      idempotencyKey: "intent-storage-purge-guard",
      runtimeCredentialId: "credential-1",
      tenantId: "tenant-1",
      teamId: "team-1",
      externalJobId: "job-1",
      sourceService: "openmontage",
    },
  });

  assert.throws(
    () => purgeWorkspaceStorageSync(workspace.id),
    /OpenMontage audit evidence exists/,
  );
  assert.notEqual(readWorkspaceSync(workspace.id), null);
  assert.equal(existsSync(workspaceDir), true);
  assert.equal(tosObjects.has(attachment.storageKey ?? ""), true);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});

function seedWorkspaceAttachment(workspaceId: string, fileName: string, content: string) {
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    workspaceId,
    fileName,
    mediaType: "text/plain",
    contentBytes: Buffer.from(content, "utf8"),
  });
  replaceStoredAttachmentsSync({
    messages: [{
      id: `message-${workspaceId}`,
      speaker: "Atlas",
      role: "agent",
      time: "2026-01-01T00:00:00.000Z",
      summary: fileName,
      status: "completed",
      attachments: [attachment],
    }],
  }, workspaceId);
  return attachment;
}

function seedWorkspaceRecords(workspaceId: string, suffix: string): void {
  const db = getDatabase();
  const now = "2026-01-01T00:00:00.000Z";

  writeWorkspaceStateRecordSync({
    organizationName: `${suffix} org`,
    humanMembers: [],
    activeEmployees: [],
    channels: [],
    messages: [],
    pendingHandoffs: 0,
    pendingApprovals: [],
    tasks: [],
    materials: [],
    knowledgePages: [],
    tables: [],
    automations: [],
    schedules: [],
    templates: [],
    channelDocuments: [],
    channelDocumentAccesses: [],
    ledger: [],
    skills: [],
  }, workspaceId, { skipVersionCheck: true });

  db.prepare(
    `INSERT INTO daemon_connection (id, workspace_id, daemon_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`daemon-${suffix}`, workspaceId, `daemon-key-${suffix}`, now, now);

  db.prepare(
    `INSERT INTO agent_runtime (id, workspace_id, daemon_connection_id, provider, name, created_at, updated_at)
     VALUES (?, ?, ?, 'codex', ?, ?, ?)`,
  ).run(`runtime-${suffix}`, workspaceId, `daemon-${suffix}`, `Runtime ${suffix}`, now, now);

  db.prepare(
    `INSERT INTO agent_task_queue (
      id,
      workspace_id,
      agent_id,
      runtime_id,
      router_session_id,
      status,
      input_json,
      queued_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', '{}', ?, ?, ?)`,
  ).run(`queue-${suffix}`, workspaceId, `agent:${suffix}`, `runtime-${suffix}`, `router-session-${suffix}`, now, now, now);

  db.prepare(
    `INSERT INTO agent_router_session (
      id,
      workspace_id,
      agent_id,
      conversation_key,
      source_type,
      status,
      title,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 'task', 'active', ?, ?, ?)`,
  ).run(`router-session-${suffix}`, workspaceId, `agent:${suffix}`, `task:queue-${suffix}`, `Router ${suffix}`, now, now);

  db.prepare(
    `INSERT INTO agent_router_provider_session (
      id,
      workspace_id,
      router_session_id,
      runtime_id,
      provider,
      provider_session_id,
      status,
      last_used_at,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 'codex', ?, 'active', ?, '{}', ?, ?)`,
  ).run(`provider-session-${suffix}`, workspaceId, `router-session-${suffix}`, `runtime-${suffix}`, `native-session-${suffix}`, now, now, now);

  db.prepare(
    `INSERT INTO agent_task_attempt (
      id,
      workspace_id,
      task_queue_id,
      router_session_id,
      runtime_id,
      provider,
      provider_session_id,
      status,
      metadata_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'codex', ?, 'claimed', '{}', ?, ?)`,
  ).run(`attempt-${suffix}`, workspaceId, `queue-${suffix}`, `router-session-${suffix}`, `runtime-${suffix}`, `native-session-${suffix}`, now, now);

  db.prepare(
    `INSERT INTO agent_router_event (
      id,
      workspace_id,
      router_session_id,
      task_queue_id,
      attempt_id,
      type,
      actor_type,
      runtime_id,
      provider,
      summary,
      data_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, 'runtime_selected', 'system', ?, 'codex', ?, '{}', ?)`,
  ).run(`router-event-${suffix}`, workspaceId, `router-session-${suffix}`, `queue-${suffix}`, `attempt-${suffix}`, `runtime-${suffix}`, `Event ${suffix}`, now);

  db.prepare(
    `INSERT INTO agent_router_context_snapshot (
      id,
      workspace_id,
      router_session_id,
      task_queue_id,
      snapshot_type,
      content_markdown,
      source_event_ids_json,
      created_at
    ) VALUES (?, ?, ?, ?, 'context', ?, '[]', ?)`,
  ).run(`router-snapshot-${suffix}`, workspaceId, `router-session-${suffix}`, `queue-${suffix}`, `# Snapshot ${suffix}`, now);
}

function countWhere(db: ReturnType<typeof getDatabase>, tableName: string, columnName: string, value: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} = ?`).get(value) as { count: number }
  ).count;
}
