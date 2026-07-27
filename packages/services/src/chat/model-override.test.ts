import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  upsertWorkspaceMembershipSync,
  upsertWorkspaceSsoBindingSync,
  createStoredEmployeeSync,
  readAgentRouterSessionSync,
} from "@dofe-agent/db";
import { createEmployeeSync } from "../employees/employees.ts";
import { createChannelSync } from "../channels/channels.ts";
import { setSessionModelOverrideForChatCommandSync } from "./model-override.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-chat-model-override-"));
const WORKSPACE_ID = "chat-model-override-workspace";
const OWNER = "owner-user";
const EMPLOYEE_NAME = "assistant";

function seed(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(OWNER, OWNER, now, now);
  db.prepare(
    "INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID, OWNER, now, now);
  upsertWorkspaceMembershipSync({ workspaceId: WORKSPACE_ID, userId: OWNER, role: "owner" });
  upsertWorkspaceSsoBindingSync({
    workspaceId: WORKSPACE_ID,
    tenantId: "tenant-1",
    tenantName: "Acme",
    teamId: "team-1",
    teamName: "Engineering",
    source: "team",
  });
}

function createEmployee(): void {
  createEmployeeSync(
    {
      name: EMPLOYEE_NAME,
      remarkName: "Assistant",
      ownerUserId: OWNER,
    },
    WORKSPACE_ID,
  );
}

function createChannel(name: string, employeeNames: string[]): void {
  createChannelSync(
    {
      name,
      kind: "group",
      humanMemberNames: [OWNER],
      employeeNames,
    },
    WORKSPACE_ID,
  );
}

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM workspace_employee");
  db.exec("DELETE FROM workspace_sso_binding");
  db.exec("DELETE FROM workspace_membership");
  db.exec("DELETE FROM workspace_snapshot");
  db.exec("DELETE FROM workspace");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM audit_log");
  seed();
  createEmployee();
});

after(() => {
  process.chdir(originalCwd);
});

test("sets session model override for a direct contact", () => {
  const result = setSessionModelOverrideForChatCommandSync({
    workspaceId: WORKSPACE_ID,
    contactId: EMPLOYEE_NAME,
    humanMemberName: OWNER,
    content: "",
    modelId: "claude-opus",
  });

  assert.equal(result.agentName, EMPLOYEE_NAME);
  assert.ok(result.routerSessionId);

  const session = readAgentRouterSessionSync(result.routerSessionId);
  assert.ok(session);
  assert.equal(session!.modelOverride, "claude-opus");
  assert.equal(session!.modelOverrideSource, "manual");
});

test("clears session model override for a direct contact", () => {
  const first = setSessionModelOverrideForChatCommandSync({
    workspaceId: WORKSPACE_ID,
    contactId: EMPLOYEE_NAME,
    humanMemberName: OWNER,
    content: "",
    modelId: "claude-opus",
  });

  const second = setSessionModelOverrideForChatCommandSync({
    workspaceId: WORKSPACE_ID,
    contactId: EMPLOYEE_NAME,
    humanMemberName: OWNER,
    content: "",
    modelId: undefined,
  });

  assert.equal(second.routerSessionId, first.routerSessionId);
  const session = readAgentRouterSessionSync(second.routerSessionId);
  assert.ok(session);
  assert.equal(session!.modelOverride, undefined);
});

test("group channel requires exactly one agent mention", () => {
  createChannel("general", [EMPLOYEE_NAME]);
  assert.throws(
    () =>
      setSessionModelOverrideForChatCommandSync({
        workspaceId: WORKSPACE_ID,
        channelName: "general",
        humanMemberName: OWNER,
        content: "set model",
        modelId: "claude-opus",
      }),
    /model_command.agent_required/,
  );
});

test("sets session model override for a group channel mention", () => {
  createChannel("general", [EMPLOYEE_NAME]);
  const result = setSessionModelOverrideForChatCommandSync({
    workspaceId: WORKSPACE_ID,
    channelName: "general",
    humanMemberName: OWNER,
    content: `@${EMPLOYEE_NAME}`,
    modelId: "claude-opus",
  });

  assert.equal(result.agentName, EMPLOYEE_NAME);
  assert.ok(result.routerSessionId);
  const session = readAgentRouterSessionSync(result.routerSessionId);
  assert.ok(session);
  assert.equal(session!.modelOverride, "claude-opus");
});
