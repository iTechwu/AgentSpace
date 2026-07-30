import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createUserSync,
  createWorkspaceSync,
  getDatabase,
} from "@dofe-agent/db";
import {
  createFeishuAgentBotBindingSync,
  disableFeishuAgentBotBindingSync,
  listFeishuAgentBotBindingsSync,
  readFeishuAgentBotBindingByAgentSync,
  rotateFeishuAgentBotCredentialsSync,
  updateFeishuAgentBotPolicySync,
} from "../agent-bot-bindings.ts";
import {
  readFeishuIntegrationCredentials,
  summarizeFeishuStoredCredentials,
} from "../credentials.ts";

const originalCwd = process.cwd();
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..", "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-feishu-agent-bots-"));
const databaseTestOptions = process.env.DOFE_AGENT_FEISHU_AGENT_BOT_DB_TESTS === "1"
  ? {}
  : { skip: "Set DOFE_AGENT_FEISHU_AGENT_BOT_DB_TESTS=1 with a test Postgres URL to run Feishu agent bot DB tests." };

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
  process.env.DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY = Buffer
    .from("0123456789abcdef0123456789abcdef", "utf8")
    .toString("base64");
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM external_integration_event;
    DELETE FROM external_message_outbox;
    DELETE FROM external_message_mapping;
    DELETE FROM external_thread_binding;
    DELETE FROM external_channel_binding;
    DELETE FROM external_user_binding;
    DELETE FROM external_integration;
    DELETE FROM workspace;
  `);
});

test("Feishu agent bot binding defaults to websocket worker with only app credentials", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-basic",
    name: "Feishu Agent Bot Basic",
    createdBy: "system",
  });

  const binding = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_bot",
    appSecret: "super-secret",
  });

  assert.equal(binding.agentId, "Codex");
  assert.equal(binding.transportMode, "websocket_worker");
  assert.equal(binding.displayName, "Codex Feishu Bot");
  assert.deepEqual(summarizeFeishuStoredCredentials(binding), {
    hasAppSecret: true,
    hasVerificationToken: false,
    hasEncryptKey: false,
  });
  assert.deepEqual(readFeishuIntegrationCredentials(binding), {
    appSecret: "super-secret",
    verificationToken: "",
    encryptKey: undefined,
  });
  assert.equal(readFeishuAgentBotBindingByAgentSync({
    workspaceId: workspace.id,
    agentId: "Codex",
  })?.id, binding.id);
  assert.deepEqual(listFeishuAgentBotBindingsSync({
    workspaceId: workspace.id,
  }).map((item) => item.id), [binding.id]);
});

test("Feishu agent bot binding stores channel and guest policies in config", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-policies",
    name: "Feishu Agent Bot Policies",
    createdBy: "system",
  });

  const binding = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_policy_bot",
    appSecret: "super-secret",
    channelAutoProvisioning: {
      botAdded: "pending_admin_review",
      firstMessage: "reply_with_setup_card",
      reviewStatus: "pending_admin_review",
    },
    externalGuestPolicy: {
      unboundUserMode: "require_identity",
      guestPermissionProfile: "none",
      requireIdentityFor: ["writes", "approvals", "private_resources"],
    },
  });

  assert.deepEqual(JSON.parse(binding.configJson), {
    eventCallbackPath: "/api/integrations/feishu/events",
    agentBotBinding: true,
    dataPlane: {
      docs: true,
      sheets: true,
      base: true,
    },
    channelAutoProvisioning: {
      botAdded: "pending_admin_review",
      firstMessage: "reply_with_setup_card",
      reviewStatus: "pending_admin_review",
    },
    externalGuestPolicy: {
      unboundUserMode: "require_identity",
      guestPermissionProfile: "none",
      requireIdentityFor: ["writes", "approvals", "private_resources"],
    },
  });

  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Hermes",
    appId: "cli_invalid_policy_bot",
    appSecret: "super-secret",
    channelAutoProvisioning: {
      botAdded: "auto_create_channel",
      firstMessage: "reply_with_setup_card",
      reviewStatus: "invalid" as "approved",
    },
  }), /feishu\.agent_bot_binding\.invalid_channel_auto_provisioning_policy/);
  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Hermes",
    appId: "cli_invalid_guest_policy_bot",
    appSecret: "super-secret",
    externalGuestPolicy: {
      requireIdentityFor: ["writes", "admin_panel"],
    },
  }), /feishu\.agent_bot_binding\.invalid_external_guest_policy/);
});

test("Feishu agent bot policy updates merge with existing config", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-policy-update",
    name: "Feishu Agent Bot Policy Update",
    createdBy: "system",
  });
  const admin = createUserSync({
    displayName: "Feishu Admin",
    primaryEmail: "feishu-admin@example.com",
  });

  const binding = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_policy_update_bot",
    appSecret: "super-secret",
    channelAutoProvisioning: {
      botAdded: "pending_admin_review",
      firstMessage: "reply_with_setup_card",
      reviewStatus: "pending_admin_review",
    },
    externalGuestPolicy: {
      unboundUserMode: "require_identity",
      guestPermissionProfile: "none",
      requireIdentityFor: ["writes", "approvals"],
    },
  });

  const updated = updateFeishuAgentBotPolicySync({
    workspaceId: workspace.id,
    integrationId: binding.id,
    channelAutoProvisioning: {
      firstMessage: "disabled",
    },
    externalGuestPolicy: {
      unboundUserMode: "ignore",
      requireIdentityFor: ["writes", "approvals", "private_resources"],
    },
    updatedByUserId: admin.id,
  });

  assert.deepEqual(JSON.parse(updated.configJson), {
    eventCallbackPath: "/api/integrations/feishu/events",
    agentBotBinding: true,
    dataPlane: {
      docs: true,
      sheets: true,
      base: true,
    },
    channelAutoProvisioning: {
      botAdded: "pending_admin_review",
      firstMessage: "disabled",
      reviewStatus: "pending_admin_review",
    },
    externalGuestPolicy: {
      unboundUserMode: "ignore",
      guestPermissionProfile: "none",
      requireIdentityFor: ["writes", "approvals", "private_resources"],
    },
  });
  assert.equal(updated.updatedByUserId, admin.id);
});

test("Feishu agent bot binding keeps EventCallback verification token in advanced credentials", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-webhook",
    name: "Feishu Agent Bot Webhook",
    createdBy: "system",
  });

  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_webhook",
    appSecret: "super-secret",
    transportMode: "http_webhook",
  }), /feishu\.agent_bot_binding\.missing_verification_token/);

  const binding = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_webhook",
    appSecret: "super-secret",
    transportMode: "http_webhook",
    verificationToken: "verify-token",
    encryptKey: "encrypt-key",
  });

  assert.equal(binding.transportMode, "http_webhook");
  assert.deepEqual(summarizeFeishuStoredCredentials(binding), {
    hasAppSecret: true,
    hasVerificationToken: true,
    hasEncryptKey: true,
  });
});

test("Feishu agent bot binding rejects placeholders and duplicate bot ownership", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-duplicates",
    name: "Feishu Agent Bot Duplicates",
    createdBy: "system",
  });

  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "CHANGE_ME_APP_ID",
    appSecret: "super-secret",
  }), /feishu\.agent_bot_binding\.placeholder_value:appId/);

  createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_bot",
    appSecret: "super-secret",
  });
  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_bot_2",
    appSecret: "super-secret",
  }), /feishu\.agent_bot_binding\.duplicate_agent/);
  assert.throws(() => createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "HermesAgent",
    appId: "cli_codex_bot",
    appSecret: "super-secret",
  }), /feishu\.agent_bot_binding\.duplicate_app_tenant/);
});

test("Feishu agent bot binding transfers an explicitly selected disabled bot", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-transfer",
    name: "Feishu Agent Bot Transfer",
    createdBy: "system",
  });
  const disabled = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "ProductDesigner",
    appId: "cli_transferable_bot",
    appSecret: "old-secret",
  });
  disableFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    integrationId: disabled.id,
  });

  const transferred = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "ProductManager",
    appId: "cli_transferable_bot",
    appSecret: "new-secret",
    transferDisabledBindingId: disabled.id,
  });

  assert.equal(transferred.id, disabled.id);
  assert.equal(transferred.status, "active");
  assert.equal(transferred.agentId, "ProductManager");
  assert.deepEqual(readFeishuIntegrationCredentials(transferred), {
    appSecret: "new-secret",
    verificationToken: "",
    encryptKey: undefined,
  });
});

test("Feishu agent bot credentials can be rotated and disabled without exposing secrets", databaseTestOptions, () => {
  const workspace = createWorkspaceSync({
    slug: "feishu-agent-bot-rotate",
    name: "Feishu Agent Bot Rotate",
    createdBy: "system",
  });
  const binding = createFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    appId: "cli_codex_rotating",
    appSecret: "first-secret",
    transportMode: "http_webhook",
    verificationToken: "verify-token",
  });

  const rotated = rotateFeishuAgentBotCredentialsSync({
    workspaceId: workspace.id,
    integrationId: binding.id,
    appSecret: "second-secret",
  });
  assert.deepEqual(readFeishuIntegrationCredentials(rotated), {
    appSecret: "second-secret",
    verificationToken: "verify-token",
    encryptKey: undefined,
  });
  assert.doesNotMatch(JSON.stringify(rotated), /first-secret|second-secret|verify-token/);

  const disabled = disableFeishuAgentBotBindingSync({
    workspaceId: workspace.id,
    agentId: "Codex",
  });
  assert.equal(disabled.status, "disabled");
  assert.equal(readFeishuAgentBotBindingByAgentSync({
    workspaceId: workspace.id,
    agentId: "Codex",
  }), null);
  assert.equal(readFeishuAgentBotBindingByAgentSync({
    workspaceId: workspace.id,
    agentId: "Codex",
    includeDisabled: true,
  })?.id, binding.id);
});
