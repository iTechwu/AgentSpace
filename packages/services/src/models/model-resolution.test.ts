import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import {
  getDatabase,
  upsertWorkspaceMembershipSync,
  upsertWorkspaceSsoBindingSync,
  upsertAgentRouterSessionSync,
  setAgentRouterSessionModelOverrideSync,
  createStoredEmployeeSync,
  bindEmployeeRuntimeSync,
} from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import { createEmployeeSync } from "../employees/employees.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import {
  resolveEffectiveModelForTaskAsync,
  resolveEffectiveModelForBoundEmployeeAsync,
  validateModelOverrideForBoundEmployeeAsync,
  type ResolveEffectiveModelInput,
} from "./model-resolution.ts";
import { getModelsInternalClient, resetModelsInternalClientForTests } from "./client.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-model-resolution-"));
const WORKSPACE_ID = "model-res-workspace";
const OWNER = "owner-user";
const RUNTIME_ID = "runtime-managed-1";
const CREDENTIAL_ID = "rtc-1";
const EMPLOYEE_NAME = "researcher";
const originalRuntimeMode = process.env.DOFE_AGENT_RUNTIME_MODE;

function mockModelsClient(availableModels: Array<{ alias: string; model?: string; id?: string; isAvailable?: boolean; isEnabled?: boolean }>) {
  const client = getModelsInternalClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).runtimeCredentials.models = async () => ({
    list: availableModels.map((m) => ({
      alias: m.alias,
      model: m.model ?? m.alias,
      id: m.id ?? m.alias,
      isAvailable: m.isAvailable ?? true,
      isEnabled: m.isEnabled ?? true,
    })),
    total: availableModels.length,
  });
}

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

function createManagedRuntime(defaultModel?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_runtime (
      id, workspace_id, provider, name, version, status, device_info, metadata_json,
      provisioning_state, managed_credential_id, protocols_json, default_model, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RUNTIME_ID,
    WORKSPACE_ID,
    "claude",
    "Managed Claude Runtime",
    "1.0.0",
    "online",
    "managed",
    JSON.stringify({ mode: "remote" }),
    "managed",
    CREDENTIAL_ID,
    JSON.stringify(["anthropic"]),
    defaultModel ?? null,
    now,
    now,
  );
}

function createEmployee(defaultModel?: string): void {
  createEmployeeSync(
    {
      name: EMPLOYEE_NAME,
      remarkName: "Researcher",
      defaultModel,
      ownerUserId: OWNER,
    },
    WORKSPACE_ID,
  );
}

function createRouterSession(overrideModel?: string): string {
  const session = upsertAgentRouterSessionSync({
    workspaceId: WORKSPACE_ID,
    agentId: EMPLOYEE_NAME,
    conversationKey: `conv-${Date.now()}`,
    sourceType: "channel",
  });
  if (overrideModel) {
    setAgentRouterSessionModelOverrideSync({
      routerSessionId: session.id,
      modelOverride: overrideModel,
      source: "manual",
    });
  }
  return session.id;
}

function setTeamPolicyDefaultModel(defaultModel: string): void {
  const state = ensureWorkspaceStateSync(WORKSPACE_ID);
  (state as unknown as { runtimePolicy?: { defaultModel?: string } }).runtimePolicy = { defaultModel };
  writeWorkspaceStateSync(state, WORKSPACE_ID);
}

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
  process.env.MODELS_BASE_URL = "http://models.test";
  process.env.MODELS_SERVICE_NAME = "agent-space-test";
  process.env.MODELS_INTERNAL_API_SECRET = "test-secret";
  process.env.DOFE_AGENT_RUNTIME_MODE = "remote";
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
  resetModelsInternalClientForTests();
});

after(() => {
  process.chdir(originalCwd);
  delete process.env.MODELS_BASE_URL;
  delete process.env.MODELS_SERVICE_NAME;
  delete process.env.MODELS_INTERNAL_API_SECRET;
  if (originalRuntimeMode === undefined) {
    delete process.env.DOFE_AGENT_RUNTIME_MODE;
  } else {
    process.env.DOFE_AGENT_RUNTIME_MODE = originalRuntimeMode;
  }
});

async function resolve(input: Omit<ResolveEffectiveModelInput, "workspaceId" | "runtimeId">) {
  return resolveEffectiveModelForTaskAsync({
    workspaceId: WORKSPACE_ID,
    runtimeId: RUNTIME_ID,
    ...input,
  });
}

test("session override wins when model is available", async () => {
  mockModelsClient([{ alias: "coding-pro" }, { alias: "general" }]);
  createManagedRuntime("general");
  createEmployee();
  const routerSessionId = createRouterSession("coding-pro");

  const result = await resolve({ employeeName: EMPLOYEE_NAME, routerSessionId });

  assert.equal(result.modelId, "coding-pro");
  assert.equal(result.source, "session_override");
  assert.equal(result.runtimeCredentialId, CREDENTIAL_ID);
  assert.equal(result.validated, true);
});

test("employee default wins when no session override", async () => {
  mockModelsClient([{ alias: "coding-pro" }, { alias: "general" }]);
  createManagedRuntime("general");
  createEmployee("coding-pro");
  const routerSessionId = createRouterSession();

  const result = await resolve({ employeeName: EMPLOYEE_NAME, routerSessionId });

  assert.equal(result.modelId, "coding-pro");
  assert.equal(result.source, "employee_default");
});

test("runtime default wins when no employee default", async () => {
  mockModelsClient([{ alias: "coding-pro" }, { alias: "general" }]);
  createManagedRuntime("general");
  createEmployee();
  const routerSessionId = createRouterSession();

  const result = await resolve({ employeeName: EMPLOYEE_NAME, routerSessionId });

  assert.equal(result.modelId, "general");
  assert.equal(result.source, "runtime_default");
});

test("team policy default wins when no runtime default", async () => {
  mockModelsClient([{ alias: "team-default" }, { alias: "fallback" }]);
  createManagedRuntime();
  createEmployee();
  setTeamPolicyDefaultModel("team-default");
  const routerSessionId = createRouterSession();

  const result = await resolve({ employeeName: EMPLOYEE_NAME, routerSessionId });

  assert.equal(result.modelId, "team-default");
  assert.equal(result.source, "team_policy_default");
});

test("protocol fallback is used as last resort", async () => {
  mockModelsClient([{ alias: "fallback" }, { alias: "disabled", isEnabled: false }]);
  createManagedRuntime();
  createEmployee();
  const routerSessionId = createRouterSession();

  const result = await resolve({ employeeName: EMPLOYEE_NAME, routerSessionId });

  assert.equal(result.modelId, "fallback");
  assert.equal(result.source, "protocol_fallback");
});

test("invalid session override is rejected instead of silently changing the selected model", async () => {
  mockModelsClient([{ alias: "general" }]);
  createManagedRuntime("general");
  createEmployee("general");
  const routerSessionId = createRouterSession("unknown-model");

  await assert.rejects(
    resolve({ employeeName: EMPLOYEE_NAME, routerSessionId }),
    /model_resolution.session_override_unavailable/,
  );
});

test("unmanaged runtime is rejected", async () => {
  mockModelsClient([{ alias: "general" }]);
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_runtime (
      id, workspace_id, provider, name, version, status, device_info, metadata_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    RUNTIME_ID,
    WORKSPACE_ID,
    "claude",
    "Local Runtime",
    "1.0.0",
    "online",
    "local",
    JSON.stringify({ mode: "local" }),
    now,
    now,
  );
  createEmployee();

  await assert.rejects(
    resolve({ employeeName: EMPLOYEE_NAME }),
    /model_resolution.not_a_managed_runtime/,
  );
});

test("resolveEffectiveModelForBoundEmployeeAsync uses the bound runtime", async () => {
  mockModelsClient([{ alias: "bound-model" }]);
  createManagedRuntime("bound-model");
  createEmployee();
  bindEmployeeRuntimeSync({
    workspaceId: WORKSPACE_ID,
    employeeName: EMPLOYEE_NAME,
    runtimeId: RUNTIME_ID,
  });

  const result = await resolveEffectiveModelForBoundEmployeeAsync({
    workspaceId: WORKSPACE_ID,
    employeeName: EMPLOYEE_NAME,
  });

  assert.equal(result.modelId, "bound-model");
  assert.equal(result.source, "runtime_default");
});

test("chat overrides are validated against the enabled bound Runtime catalog", async () => {
  mockModelsClient([
    { alias: "available", model: "provider-model" },
    { alias: "disabled", isEnabled: false },
  ]);
  createManagedRuntime();
  createEmployee();
  bindEmployeeRuntimeSync({
    workspaceId: WORKSPACE_ID,
    employeeName: EMPLOYEE_NAME,
    runtimeId: RUNTIME_ID,
  });

  const accepted = await validateModelOverrideForBoundEmployeeAsync({
    workspaceId: WORKSPACE_ID,
    employeeName: EMPLOYEE_NAME,
    modelId: "provider-model",
  });
  assert.equal(accepted.modelId, "available");

  await assert.rejects(
    validateModelOverrideForBoundEmployeeAsync({
      workspaceId: WORKSPACE_ID,
      employeeName: EMPLOYEE_NAME,
      modelId: "disabled",
    }),
    /model_resolution.model_unavailable/,
  );
});
