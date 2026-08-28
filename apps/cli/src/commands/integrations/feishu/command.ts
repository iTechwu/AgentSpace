// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import { drainFeishuOutboxMessages, startFeishuWebSocketWorkerSupervisor } from "@dofe-agent/services/integrations";
import { getNumberFlag, getStringFlag, parseArgs } from "../../../lib/args.ts";
import { writeData, type OutputFormat } from "../../../lib/format.ts";
import { buildFeishuAgentBotCliInputFromFlags, buildFeishuAgentBotPolicyCliInputFromFlags, buildFeishuAgentChannelAccessCliInputFromFlags, buildFeishuCliAgentBotErrorReport, createFeishuAgentBotBindingForCli, disableFeishuAgentBotForCli, rotateFeishuAgentBotCredentialsForCli, setFeishuAgentChannelAccessForCli, updateFeishuAgentBotPolicyForCli } from "./agent-bot.ts";
import { buildFeishuChannelBindingsCliReport, buildFeishuCliBindingErrorReport, createFeishuChannelBindingForCli, createFeishuResourceBindingForCli, createFeishuUserBindingForCli, parseFeishuBindingStatusFlag } from "./bindings.ts";
import { hasBooleanFlag, hasHelpFlag, readStringFlagOrEnv, requireCliIntegrationId, requireNonPlaceholderFeishuAgentBotValue, requireStringFlag, requireStringFlagOrEnv, validateOptionalFeishuAgentBotValue } from "./cli-shared.ts";
import { buildFeishuCliCreateErrorReport, buildFeishuCreateCliInputFromFlags, createFeishuIntegrationForCli, readFeishuCreateCliEnv } from "./create.ts";
import { buildFeishuCliDataOperationParameters, runFeishuDataOperationApprovalReviewForCli, runFeishuDataOperationForCli } from "./data-operations.ts";
import { buildFeishuEvidenceReport, formatFeishuEvidenceCommandText } from "./evidence.ts";
import { buildFeishuReadinessReport, readFeishuCliPublicAppUrl, runFeishuHealthCheckCli } from "./readiness.ts";
import { buildFeishuSmokeEnvTemplateReport, formatFeishuSmokeEnvCommandText, getFeishuSmokeEnvExitCode } from "./smoke-env.ts";
import { buildFeishuSmokePlanReport, formatFeishuSmokePlanCommandText, getFeishuSmokePlanExitCode, parseEvidenceRequirement, parseRequiredReadiness } from "./smoke-plan.ts";
import { getFeishuWorkerExitCode, waitForShutdownSignal } from "./worker.ts";

export async function runFeishuIntegrationCommand(args: string[], format: OutputFormat): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printFeishuIntegrationHelp();
    return subcommand ? 0 : 1;
  }
  const parsed = parseArgs(rest);
  if (subcommand === "worker" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "create" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (
    (
      subcommand === "bind-agent-bot" ||
      subcommand === "disable-agent-bot" ||
      subcommand === "rotate-agent-bot-secret" ||
      subcommand === "auto-provision-policy" ||
      subcommand === "agent-channel-access"
    ) &&
    hasHelpFlag(parsed.flags)
  ) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "readiness" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "agent-bot-readiness" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "smoke-plan" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "smoke-env" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "health-check" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "evidence" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "data-operation" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "review-data-operation" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (subcommand === "channel-bindings" && hasHelpFlag(parsed.flags)) {
    printFeishuIntegrationHelp();
    return 0;
  }
  if (
    (subcommand === "bind-channel" || subcommand === "bind-user" || subcommand === "bind-resource") &&
    hasHelpFlag(parsed.flags)
  ) {
    printFeishuIntegrationHelp();
    return 0;
  }

  if (
    subcommand !== "worker" &&
    subcommand !== "create" &&
    subcommand !== "bind-agent-bot" &&
    subcommand !== "disable-agent-bot" &&
    subcommand !== "rotate-agent-bot-secret" &&
    subcommand !== "auto-provision-policy" &&
    subcommand !== "agent-channel-access" &&
    subcommand !== "readiness" &&
    subcommand !== "agent-bot-readiness" &&
    subcommand !== "smoke-plan" &&
    subcommand !== "smoke-env" &&
    subcommand !== "health-check" &&
    subcommand !== "evidence" &&
    subcommand !== "data-operation" &&
    subcommand !== "review-data-operation" &&
    subcommand !== "channel-bindings" &&
    subcommand !== "bind-channel" &&
    subcommand !== "bind-user" &&
    subcommand !== "bind-resource"
  ) {
    printFeishuIntegrationHelp();
    return 1;
  }

  const workspaceId = getStringFlag(parsed.flags, "workspace-id")
    ?? getStringFlag(parsed.flags, "workspace")
    ?? process.env.DOFE_AGENT_WORKSPACE_ID?.trim()
    ?? "default";
  const integrationId = getStringFlag(parsed.flags, "integration")
    ?? getStringFlag(parsed.flags, "integration-id")
    ?? process.env.DOFE_AGENT_FEISHU_INTEGRATION_ID?.trim();
  const limit = getNumberFlag(parsed.flags, "limit", 50);
  const refreshIntervalMs = getNumberFlag(parsed.flags, "refresh-interval", 15_000);
  const outboxDrainIntervalMs = getNumberFlag(parsed.flags, "outbox-drain-interval", 2_000);
  const lockedBy = getStringFlag(parsed.flags, "locked-by")
    ?? process.env.DOFE_AGENT_FEISHU_WORKER_ID?.trim()
    ?? "dofe-agent-feishu-worker";
  const baseUrl = getStringFlag(parsed.flags, "base-url")
    ?? process.env.DOFE_AGENT_FEISHU_API_BASE_URL?.trim();
  const appUrl = getStringFlag(parsed.flags, "app-url")
    ?? readFeishuCliPublicAppUrl();
  const domain = getStringFlag(parsed.flags, "domain")
    ?? process.env.DOFE_AGENT_FEISHU_WS_DOMAIN?.trim();
  const dryRun = hasBooleanFlag(parsed.flags, "dry-run");
  const includeWebhookIntegrations = hasBooleanFlag(parsed.flags, "include-webhook");
  const drainOutboxOnly = hasBooleanFlag(parsed.flags, "drain-outbox") || hasBooleanFlag(parsed.flags, "once");
  const strictReadiness = hasBooleanFlag(parsed.flags, "strict");
  const createdByUserId = getStringFlag(parsed.flags, "created-by-user-id")
    ?? getStringFlag(parsed.flags, "created-by");

  if (subcommand === "readiness") {
    const requiredReadiness = parseRequiredReadiness(getStringFlag(parsed.flags, "require"));
    const report = buildFeishuReadinessReport({
      workspaceId,
      integrationId,
      requiredReadiness,
    });
    writeData(format, report);
    return report.integrationCount === 0 || (strictReadiness && !report.strictSatisfied) ? 1 : 0;
  }

  if (subcommand === "agent-bot-readiness") {
    const requiredReadiness = parseRequiredReadiness(getStringFlag(parsed.flags, "require"));
    const report = buildFeishuReadinessReport({
      workspaceId,
      integrationId,
      agentId: getStringFlag(parsed.flags, "agent")
        ?? getStringFlag(parsed.flags, "agent-id")
        ?? getStringFlag(parsed.flags, "agent-name"),
      agentOnly: true,
      requiredReadiness,
    });
    writeData(format, report);
    return report.integrationCount === 0 || (strictReadiness && !report.strictSatisfied) ? 1 : 0;
  }

  if (subcommand === "create") {
    try {
      const report = createFeishuIntegrationForCli(buildFeishuCreateCliInputFromFlags({
        workspaceId,
        flags: parsed.flags,
        createdByUserId,
        appUrl,
        env: readFeishuCreateCliEnv({
          envFilePath: getStringFlag(parsed.flags, "env-file"),
        }),
      }));
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliCreateErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "bind-agent-bot") {
    try {
      const report = createFeishuAgentBotBindingForCli(buildFeishuAgentBotCliInputFromFlags({
        workspaceId,
        flags: parsed.flags,
        actorUserId: createdByUserId,
        env: readFeishuCreateCliEnv({
          envFilePath: getStringFlag(parsed.flags, "env-file"),
        }),
      }));
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliAgentBotErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "disable-agent-bot") {
    try {
      const report = disableFeishuAgentBotForCli({
        workspaceId,
        integrationId,
        agentId: getStringFlag(parsed.flags, "agent") ?? getStringFlag(parsed.flags, "agent-id") ?? getStringFlag(parsed.flags, "agent-name"),
        actorUserId: createdByUserId,
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliAgentBotErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "rotate-agent-bot-secret") {
    try {
      const env = readFeishuCreateCliEnv({
        envFilePath: getStringFlag(parsed.flags, "env-file"),
      });
      const report = rotateFeishuAgentBotCredentialsForCli({
        workspaceId,
        integrationId,
        agentId: getStringFlag(parsed.flags, "agent") ?? getStringFlag(parsed.flags, "agent-id") ?? getStringFlag(parsed.flags, "agent-name"),
        appId: validateOptionalFeishuAgentBotValue("app_id", readStringFlagOrEnv({
          flags: parsed.flags,
          flagKeys: ["app-id", "app_id"],
          envFlagKeys: ["app-id-env", "app_id_env"],
          defaultEnvNames: [],
          env,
        })),
        appSecret: requireNonPlaceholderFeishuAgentBotValue("app_secret", requireStringFlagOrEnv({
          flags: parsed.flags,
          flagKeys: ["app-secret", "app_secret"],
          envFlagKeys: ["app-secret-env", "app_secret_env"],
          defaultEnvNames: ["FEISHU_APP_SECRET", "DOFE_AGENT_FEISHU_APP_SECRET"],
          missingCode: "feishu.agent_bot_binding.missing_app_secret",
          env,
        })),
        verificationToken: validateOptionalFeishuAgentBotValue("verification_token", readStringFlagOrEnv({
          flags: parsed.flags,
          flagKeys: ["verification-token", "verification_token"],
          envFlagKeys: ["verification-token-env", "verification_token_env"],
          defaultEnvNames: ["FEISHU_VERIFICATION_TOKEN", "DOFE_AGENT_FEISHU_VERIFICATION_TOKEN"],
          env,
        })),
        encryptKey: validateOptionalFeishuAgentBotValue("encrypt_key", readStringFlagOrEnv({
          flags: parsed.flags,
          flagKeys: ["encrypt-key", "encrypt_key"],
          envFlagKeys: ["encrypt-key-env", "encrypt_key_env"],
          defaultEnvNames: ["FEISHU_ENCRYPT_KEY", "DOFE_AGENT_FEISHU_ENCRYPT_KEY"],
          env,
        })),
        tenantKey: validateOptionalFeishuAgentBotValue("tenant_key", readStringFlagOrEnv({
          flags: parsed.flags,
          flagKeys: ["tenant-key", "tenant_key"],
          envFlagKeys: ["tenant-key-env", "tenant_key_env"],
          defaultEnvNames: [],
          env,
        })),
        actorUserId: createdByUserId,
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliAgentBotErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "auto-provision-policy") {
    try {
      const report = updateFeishuAgentBotPolicyForCli(buildFeishuAgentBotPolicyCliInputFromFlags({
        workspaceId,
        integrationId,
        flags: parsed.flags,
        actorUserId: createdByUserId,
      }));
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliAgentBotErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "agent-channel-access") {
    try {
      const report = setFeishuAgentChannelAccessForCli(buildFeishuAgentChannelAccessCliInputFromFlags({
        workspaceId,
        integrationId,
        flags: parsed.flags,
        actorUserId: createdByUserId,
      }));
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliAgentBotErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "smoke-plan") {
    const requiredReadiness = parseRequiredReadiness(getStringFlag(parsed.flags, "require"));
    const report = buildFeishuSmokePlanReport({
      workspaceId,
      integrationId,
      requiredReadiness,
      appUrl,
    });
    if (format === "json") {
      writeData(format, report);
    } else {
      console.log(formatFeishuSmokePlanCommandText(report));
    }
    return getFeishuSmokePlanExitCode(report, { strict: strictReadiness });
  }

  if (subcommand === "smoke-env") {
    const report = buildFeishuSmokeEnvTemplateReport({
      workspaceId,
      integrationId,
      appUrl,
    });
    if (format === "json") {
      writeData(format, report);
    } else {
      const output = formatFeishuSmokeEnvCommandText(report);
      if (output.stderr) {
        console.error(output.stderr);
      }
      if (output.stdout) {
        console.log(output.stdout);
      }
    }
    return getFeishuSmokeEnvExitCode(report);
  }

  if (subcommand === "evidence") {
    const report = buildFeishuEvidenceReport({
      workspaceId,
      integrationId,
      requiredEvidence: parseEvidenceRequirement(getStringFlag(parsed.flags, "require")),
      openApiEvidencePath: getStringFlag(parsed.flags, "openapi-evidence")
        ?? getStringFlag(parsed.flags, "open-api-evidence")
        ?? getStringFlag(parsed.flags, "evidence-artifact"),
      botAddedPayloadEvidencePath: getStringFlag(parsed.flags, "bot-added-payload-evidence")
        ?? getStringFlag(parsed.flags, "bot_added_payload_evidence"),
    });
    if (format === "json") {
      writeData(format, report);
    } else {
      console.log(formatFeishuEvidenceCommandText(report));
    }
    return report.integrationCount === 0 || (strictReadiness && !report.strictSatisfied) ? 1 : 0;
  }

  if (subcommand === "health-check") {
    const agentId = getStringFlag(parsed.flags, "agent")
      ?? getStringFlag(parsed.flags, "agent-id")
      ?? getStringFlag(parsed.flags, "agent-name");
    const report = await runFeishuHealthCheckCli({
      workspaceId,
      integrationId,
      agentId,
      agentOnly: Boolean(agentId),
      baseUrl,
      persist: !dryRun,
    });
    writeData(format, report);
    return report.integrationCount === 0 ||
      report.errorCount > 0 ||
      (strictReadiness && !report.strictSatisfied)
      ? 1
      : 0;
  }

  if (subcommand === "data-operation") {
    const report = await runFeishuDataOperationForCli({
      workspaceId,
      integrationId: requireCliIntegrationId(integrationId),
      operation: requireStringFlag(parsed.flags, "operation"),
      providerResourceType: getStringFlag(parsed.flags, "type"),
      resourceUrlOrToken: requireStringFlag(parsed.flags, "resource"),
      actorType: getStringFlag(parsed.flags, "actor-type"),
      actorId: getStringFlag(parsed.flags, "actor-id"),
      approvalAgentId: getStringFlag(parsed.flags, "approval-agent")
        ?? getStringFlag(parsed.flags, "approval-agent-id"),
      approvalChannelName: getStringFlag(parsed.flags, "approval-channel")
        ?? getStringFlag(parsed.flags, "approval-channel-name"),
      approvalContentPreview: getStringFlag(parsed.flags, "approval-preview"),
      baseUrl,
      parameters: buildFeishuCliDataOperationParameters(parsed.flags),
    });
    writeData(format, report);
    return report.ok ? 0 : 1;
  }

  if (subcommand === "review-data-operation") {
    const report = await runFeishuDataOperationApprovalReviewForCli({
      workspaceId,
      approvalId: requireStringFlag(parsed.flags, "approval-id"),
      decision: requireStringFlag(parsed.flags, "decision"),
      reviewerComment: getStringFlag(parsed.flags, "comment"),
      baseUrl,
    });
    writeData(format, report);
    return report.ok ? 0 : 1;
  }

  if (subcommand === "channel-bindings") {
    try {
      const report = buildFeishuChannelBindingsCliReport({
        workspaceId,
        integrationId,
        status: parseFeishuBindingStatusFlag(getStringFlag(parsed.flags, "status")),
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliBindingErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "bind-channel") {
    try {
      const report = createFeishuChannelBindingForCli({
        workspaceId,
        integrationId: requireCliIntegrationId(integrationId),
        channelName: requireStringFlag(parsed.flags, "channel"),
        externalChatId: requireStringFlag(parsed.flags, "chat-id"),
        externalChatType: getStringFlag(parsed.flags, "chat-type") ?? "group",
        externalChatName: getStringFlag(parsed.flags, "chat-name"),
        createdByUserId,
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliBindingErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "bind-user") {
    try {
      const report = createFeishuUserBindingForCli({
        workspaceId,
        integrationId: requireCliIntegrationId(integrationId),
        userId: requireStringFlag(parsed.flags, "user-id"),
        externalUserId: requireStringFlag(parsed.flags, "open-id"),
        externalUnionId: getStringFlag(parsed.flags, "union-id"),
        externalOpenId: getStringFlag(parsed.flags, "feishu-user-id"),
        externalEmail: getStringFlag(parsed.flags, "email"),
        displayName: getStringFlag(parsed.flags, "display-name"),
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliBindingErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (subcommand === "bind-resource") {
    try {
      const report = createFeishuResourceBindingForCli({
        workspaceId,
        integrationId: requireCliIntegrationId(integrationId),
        providerResourceType: requireStringFlag(parsed.flags, "type"),
        resourceUrlOrToken: requireStringFlag(parsed.flags, "resource"),
        dofeAgentResourceType: requireStringFlag(parsed.flags, "dofe-agent-type"),
        dofeAgentResourceId: getStringFlag(parsed.flags, "dofe-agent-id") ?? "",
        channelName: getStringFlag(parsed.flags, "channel"),
        displayName: getStringFlag(parsed.flags, "display-name"),
        allowWrite: hasBooleanFlag(parsed.flags, "allow-write"),
        guestReadable: hasBooleanFlag(parsed.flags, "guest-readable"),
        createdByUserId,
        createdBy: getStringFlag(parsed.flags, "created-by-name") ?? "DofeAgent CLI",
      });
      writeData(format, report);
      return 0;
    } catch (error) {
      const report = buildFeishuCliBindingErrorReport(error);
      if (!report) {
        throw error;
      }
      writeData(format, report);
      return 1;
    }
  }

  if (!drainOutboxOnly) {
    const worker = await startFeishuWebSocketWorkerSupervisor({
      workspaceId,
      integrationId,
      lockedBy,
      baseUrl,
      domain,
      drainOutboxLimit: limit,
      refreshIntervalMs,
      outboxDrainIntervalMs,
      dryRun,
      includeWebhookIntegrations,
    });
    writeData(format, worker.summary);
    if (dryRun) {
      return worker.summary.errors.length > 0 ? 1 : 0;
    }
    if (worker.summary.startedCount === 0) {
      worker.close();
      return worker.summary.errors.length > 0 ? 1 : 0;
    }
    await waitForShutdownSignal();
    worker.close();
    writeData(format, {
      ...worker.summary,
      metrics: worker.metrics,
      connectionStatuses: worker.getConnectionStatuses(),
    });
    return getFeishuWorkerExitCode(worker.metrics);
  }

  const result = await drainFeishuOutboxMessages({
    workspaceId,
    integrationId,
    limit,
    lockedBy,
    baseUrl,
  });
  writeData(format, result);
  return result.errors.length > 0 && result.processedCount === 0 ? 1 : 0;
}
export function printFeishuIntegrationHelp(): void {
  console.log(`Usage:
  dofe-agent integrations feishu create --workspace-id <id> [--env-file scripts/feishu/.env] --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --verification-token-env FEISHU_VERIFICATION_TOKEN [--encrypt-key-env FEISHU_ENCRYPT_KEY] [--tenant-key-env FEISHU_TENANT_KEY] [--name <name>] [--transport http_webhook|websocket_worker] [--app-url <url>] [--json]
  dofe-agent integrations feishu bind-agent-bot --workspace-id <id> --agent <agent-id-or-name> [--env-file scripts/feishu/.env] --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --verification-token-env FEISHU_VERIFICATION_TOKEN [--transport http_webhook|websocket_worker] [--encrypt-key-env FEISHU_ENCRYPT_KEY] [--tenant-key-env FEISHU_TENANT_KEY] [--json]
  dofe-agent integrations feishu rotate-agent-bot-secret --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) [--env-file scripts/feishu/.env] --app-secret-env FEISHU_APP_SECRET [--app-id-env FEISHU_APP_ID] [--json]
  dofe-agent integrations feishu disable-agent-bot --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) [--json]
  dofe-agent integrations feishu auto-provision-policy --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) [--bot-added-policy auto_create_channel|pending_admin_review|disabled] [--first-message-policy auto_create_if_bot_mentioned|pending_admin_review|reply_with_setup_card|disabled] [--review-status approved|pending_admin_review|needs_identity_binding] [--unbound-user-mode ignore|reply_on_mention|reply_all|require_identity] [--guest-permission-profile none|channel_context_only|channel_readonly] [--require-identity-for writes,approvals] [--json]
  dofe-agent integrations feishu agent-channel-access --workspace-id <id> (--agent <agent-id-or-name>|--integration <agent-bot-id>) --access enabled|disabled [--json]
  dofe-agent integrations feishu agent-bot-readiness --workspace-id <id> [--agent <agent-id-or-name>|--integration <id>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu worker [--workspace-id <id>] [--integration <id>] [--limit <n>] [--refresh-interval <ms>] [--outbox-drain-interval <ms>] [--base-url <url>] [--domain <host>] [--locked-by <id>] [--dry-run] [--include-webhook] [--drain-outbox|--once] [--json]
  dofe-agent integrations feishu readiness [--workspace-id <id>] [--integration <id>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-plan [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-env [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--json]
  dofe-agent integrations feishu health-check [--workspace-id <id>] [--integration <id>|--agent <agent-id-or-name>] [--base-url <url>] [--dry-run] [--strict] [--json]
  dofe-agent integrations feishu evidence [--workspace-id <id>] [--integration <id>] [--openapi-evidence <path>] [--bot-added-payload-evidence <path>] [--strict] [--require bot|native|guest-policy|data-plane|worker|failure|all] [--json]
  dofe-agent integrations feishu data-operation --workspace-id <id> --integration <id> --operation read-doc|plan-doc-create|plan-doc-update|plan-doc-append|read-sheet|query-base|plan-sheet-write|plan-base-update --resource <url-or-token> [--type doc|sheet|base|base_table|base_view] [--title <doc-title>] [--folder-token <folder-token>] [--parent-block-id <block-id>] [--block-id <block-id>] [--document-revision-id <n>] [--client-token <token>] [--blocks-json <json>] [--children-json <json>] [--block-json <json>] [--app-token <base-app-token>] [--table-id <base-table-id>] [--range <sheet-range>] [--values-json <json>] [--record-id <id>] [--fields-json <json>] [--approval-agent <agent-id> --approval-channel <channel>] [--json]
  dofe-agent integrations feishu review-data-operation --workspace-id <id> --approval-id <approval-id> --decision approved|rejected [--comment <text>] [--base-url <url>] [--json]
  dofe-agent integrations feishu channel-bindings --workspace-id <id> [--integration <id>] [--status active|disabled|archived] [--json]
  dofe-agent integrations feishu bind-channel --workspace-id <id> --integration <id> --channel <name> --chat-id <oc_xxx> [--chat-type group|p2p] [--chat-name <name>] [--json]
  dofe-agent integrations feishu bind-user --workspace-id <id> --integration <id> --user-id <dofe-agent-user-id> --open-id <ou_xxx> [--union-id <on_xxx>] [--feishu-user-id <id>] [--json]
  dofe-agent integrations feishu bind-resource --workspace-id <id> --integration <id> --type doc|sheet|base|base_table|base_view --resource <url-or-token> --dofe-agent-type channel_document|data_table|knowledge_page [--dofe-agent-id <id>] [--channel <name>] [--allow-write] [--guest-readable] [--json]

Options:
  --workspace-id <id>      DofeAgent workspace id; defaults to DOFE_AGENT_WORKSPACE_ID or default
  --integration <id>       Limit the worker, drain, readiness, or health run to one Feishu integration
  --agent <id-or-name>     Agent bot commands: DofeAgent agent id/name to bind to a Feishu bot
  --env-file <path>        Create: read FEISHU_* credentials from a local KEY=value file; process env wins
  --app-id-env <name>      Create/bind: read Feishu app id from an env var; defaults also check FEISHU_APP_ID
  --app-secret-env <name>  Create/bind/rotate: read Feishu app secret from an env var; defaults also check FEISHU_APP_SECRET
  --verification-token-env <name> Create/bind: read verification token from an env var; defaults also check FEISHU_VERIFICATION_TOKEN
  --encrypt-key-env <name> Create/bind: read encrypt key from an env var; defaults also check FEISHU_ENCRYPT_KEY
  --app-id <id>            Create/bind fallback for Feishu app id
  --app-secret <secret>    Create/bind/rotate fallback for Feishu app secret; env input is preferred
  --verification-token <token> Create/bind fallback for event verification token; env input is preferred
  --encrypt-key <key>      Create/bind fallback for event encrypt key; env input is preferred
  --bot-added-policy <mode> Agent bot bind/policy: auto_create_channel|pending_admin_review|disabled
  --first-message-policy <mode> Agent bot bind/policy: auto_create_if_bot_mentioned|pending_admin_review|reply_with_setup_card|disabled
  --review-status <status> Agent bot bind/policy: approved|pending_admin_review|needs_identity_binding for auto-provisioned channels
  --unbound-user-mode <mode> Agent bot bind/policy: ignore|reply_on_mention|reply_all|require_identity
  --guest-permission-profile <profile> Agent bot bind/policy: none|channel_context_only|channel_readonly
  --require-identity-for <csv> Agent bot bind/policy: comma-separated operations that require a bound DofeAgent identity
  --access <value>         Agent channel access smoke helper: enabled|disabled
  --guest-readable       Resource bind: allow external guests to read this bound resource in its current channel
  --limit <n>              Outbox drain batch size; defaults to 50
  --refresh-interval <ms>  Reconcile active Feishu bindings; defaults to 15000ms
  --outbox-drain-interval <ms> Send agent replies and status updates; defaults to 2000ms
  --base-url <url>         Feishu OpenAPI base URL; defaults to DOFE_AGENT_FEISHU_API_BASE_URL
  --app-url <url>          Public DofeAgent URL used by smoke-plan/smoke-env callback values
  --title <text>           Data operation: Feishu Doc create title; stored output only reports length
  --folder-token <token>   Data operation: Feishu Doc create folder token when different from --resource
  --parent-block-id <id>   Data operation: Feishu Doc append/create child blocks under this block
  --block-id <id>          Data operation: Feishu Doc update target block
  --document-revision-id <n> Data operation: Feishu Doc mutation revision guard
  --client-token <token>   Data operation: Feishu Doc mutation idempotency token
  --app-token <token>      Data operation: Feishu Base app token when --resource is a Base table/view id
  --table-id <id>          Data operation: Feishu Base table id when --type base/base_view is used
  --approval-agent <id>    Data operation write plans: also create a pending DofeAgent approval request for this agent
  --approval-channel <name> Data operation write plans: approval channel used with --approval-agent
  --approval-preview <text> Data operation write plans: optional safe approval preview text
  --approval-id <id>       Review data operation: approval id returned by a write plan or shown in DofeAgent approvals
  --decision <value>       Review data operation: approved/approve or rejected/reject
  --status <value>         Binding list filter: active|disabled|archived
  --domain <host>          Feishu WebSocket domain; defaults to DOFE_AGENT_FEISHU_WS_DOMAIN
  --locked-by <id>         Worker lock owner; defaults to DOFE_AGENT_FEISHU_WORKER_ID or dofe-agent-feishu-worker
  --dry-run                Validate WebSocket worker config without opening live connections
  --include-webhook        Include http_webhook integrations in dry-run/start selection
  --drain-outbox, --once   Drain due Feishu outbox messages once without opening WebSocket connections
  create                   Create a workspace-level DofeAgent Feishu integration with encrypted credentials
  bind-agent-bot           Bind one DofeAgent agent to one Feishu bot; defaults to EventCallback and requires Verification Token
  rotate-agent-bot-secret  Rotate an existing agent bot binding secret without exposing it in output
  disable-agent-bot        Disable an existing agent bot binding
  auto-provision-policy    View/update agent bot auto-provisioning and external guest policy
  agent-channel-access     Temporarily disable/restore DofeAgent agent channel-member access for Feishu no-reply smoke
  agent-bot-readiness      Summarize readiness for agent-scoped Feishu bot bindings
  readiness                Summarize local DofeAgent-side prerequisites for Feishu manual smoke
  smoke-plan               Generate the live Feishu manual smoke checklist from current local readiness
  smoke-env                Print a safe scripts/feishu/.env template with placeholders for secrets/resources
  health-check             Refresh saved Feishu health/scope status; --dry-run skips persistence
  evidence                 Summarize DofeAgent-side Feishu live smoke evidence from local DB state
  data-operation           Run a bound Feishu read or create a governed pending write/approval operation; output redacts resource tokens
  review-data-operation    Approve/reject a Feishu data operation approval and execute approved writes through DofeAgent governance
  channel-bindings         List Feishu chat -> DofeAgent channel bindings with redacted chat references
  bind-channel             Create/update a Feishu chat -> DofeAgent channel binding; output redacts chat id
  bind-user                Create/update a Feishu Open ID -> DofeAgent user binding; output redacts external ids
  bind-resource            Create/update a Feishu Docs/Sheets/Base resource binding; output redacts resource tokens
  --openapi-evidence <path> Evidence: required for --require all; verifies redacted strict live smoke artifact from pnpm run smoke:feishu
  --bot-added-payload-evidence <path> Evidence: required for --require all; verifies redacted bot-added callback payload artifact from pnpm run smoke:feishu
  --strict                 Readiness/smoke-plan/evidence: require matching proof; health-check: require all healthy
  --require <kind>         Readiness/smoke-plan gate: bot, data-plane, worker; evidence gate: bot, native, guest-policy, data-plane, worker, failure, all
  --json                   Print machine-readable output`);
}
