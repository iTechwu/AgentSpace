// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  listExternalIntegrationsSync,
  type ExternalIntegrationRecord
} from "@dofe-agent/db";
import {
  FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS,
  FEISHU_PROVIDER_ID
} from "@dofe-agent/services";
import { formatIntegrationLabel, uniqueStrings } from "./cli-shared.ts";
import { hasNonEmptyString } from "./evidence.ts";
import { buildFeishuNativeAgentBotSmokeReadiness, buildFeishuReadinessReport, buildFeishuWorkerSmokeIssues, collectDataPlaneBindingIssues, collectSetupIssues, isFeishuNativeAgentBotSmokeReady, prereqStatus, selectFeishuReadinessCandidate } from "./readiness.ts";
import { buildFeishuAgentChannelAccessSmokeCommands, buildFeishuDataPlaneSmokeCommands, buildFeishuExternalGuestPolicySmokeCommands, buildFeishuOpenPlatformSetupSummary, buildFeishuRuntimeSetupSummary, buildFeishuSmokeHarnessSummary, resolveFeishuCliOpenPlatformRequiredCredentialFields } from "./smoke-env.ts";
import { FEISHU_CLI_PLACEHOLDERS } from "./types.ts";
import { buildFeishuWorkerHarnessSummary } from "./worker.ts";
import type { BuildFeishuSmokePlanReportInput, FeishuEvidenceRequirement, FeishuRequiredReadiness, FeishuSmokePlanBlocker, FeishuSmokePlanEvidenceGate, FeishuSmokePlanReport, FeishuSmokePlanStep } from "./types.ts";

export function buildFeishuSmokePlanReport(input: BuildFeishuSmokePlanReportInput): FeishuSmokePlanReport {
  const sourceIntegrations = input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  });
  const readiness = buildFeishuReadinessReport({
    ...input,
    agentOnly: true,
    integrations: sourceIntegrations,
  });
  const nativeAgentBotReadinessSource = buildFeishuReadinessReport({
    ...input,
    integrationId: undefined,
    agentId: undefined,
    agentOnly: false,
    requiredReadiness: "bot",
    integrations: sourceIntegrations,
  });
  const scopedSourceIntegrations = sourceIntegrations.filter((integration) =>
    !input.integrationId || integration.id === input.integrationId
  );
  const hasScopedSourceIntegration = scopedSourceIntegrations.length > 0;
  const hasIntegration = readiness.integrationCount > 0;
  const activeReadinessItems = readiness.integrations.filter((item) => item.status === "active");
  const hasActiveIntegration = activeReadinessItems.length > 0;
  const botCandidate = selectFeishuReadinessCandidate(activeReadinessItems, "bot");
  const dataPlaneCandidate = selectFeishuReadinessCandidate(activeReadinessItems, "data-plane");
  const workerCandidate = selectFeishuReadinessCandidate(activeReadinessItems, "worker");
  const setupCandidate = botCandidate ?? dataPlaneCandidate ?? activeReadinessItems[0];
  const hasConfiguredAppCredentials = activeReadinessItems.some((item) =>
    item.appConfigured && item.credentialsConfigured
  );
  const hasHealthChecked = activeReadinessItems.some((item) => item.healthStatus !== "unknown");
  const hasBotAndDataPlaneScopes = activeReadinessItems.some((item) =>
    item.scopes.missingForBotSmoke.length === 0 &&
    item.scopes.missingForDataPlaneSmoke.length === 0
  );
  const hasChannelBinding = activeReadinessItems.some((item) => item.channelBindings.active > 0);
  const hasUserBinding = activeReadinessItems.some((item) => item.userBindings.active > 0);
  const hasAnyDocBinding = activeReadinessItems.some((item) => item.resourceBindings.doc > 0);
  const hasDocBinding = activeReadinessItems.some((item) => item.resourceBindings.docWritable > 0);
  const hasAnySheetBinding = activeReadinessItems.some((item) => item.resourceBindings.sheet > 0);
  const hasSheetBinding = activeReadinessItems.some((item) => item.resourceBindings.sheetWritable > 0);
  const hasAnyBaseBinding = activeReadinessItems.some((item) => item.resourceBindings.base > 0);
  const hasBaseReadyBinding = activeReadinessItems.some((item) => item.resourceBindings.baseReady > 0);
  const hasBaseBinding = activeReadinessItems.some((item) => item.resourceBindings.baseWritable > 0);
  const readyForBot = readiness.readyForBotSmokeCount > 0;
  const readyForDataPlane = readiness.readyForDataPlaneSmokeCount > 0;
  const nativeAgentBotReadiness = buildFeishuNativeAgentBotSmokeReadiness({
    readinessItems: nativeAgentBotReadinessSource.integrations,
    integrations: sourceIntegrations,
  });
  const agentBotIntegrationCount = nativeAgentBotReadiness.agentBotBindingCount;
  const hasSecondAgentBot = nativeAgentBotReadiness.ready;
  const webSocketCandidate = workerCandidate?.transportMode === "websocket_worker"
    ? workerCandidate
    : activeReadinessItems.find((item) => item.transportMode === "websocket_worker");
  const activeIntegrationIssues = buildFeishuSmokePlanActiveAgentBotIssues({
    scopedIntegrationId: input.integrationId,
    scopedSourceIntegrations,
    hasActiveAgentBotIntegration: hasActiveIntegration,
  });
  const readyForWorkerSmoke = readiness.readyForWorkerSmokeCount > 0;
  const botIssues = hasActiveIntegration ? botCandidate?.issues ?? [] : activeIntegrationIssues;
  const dataPlaneIssues = hasActiveIntegration ? dataPlaneCandidate?.issues ?? [] : activeIntegrationIssues;
  const workerIssues = readyForWorkerSmoke
    ? []
    : hasActiveIntegration
      ? buildFeishuWorkerSmokeIssues(webSocketCandidate, botIssues)
      : activeIntegrationIssues;
  const missingBotScopes = uniqueStrings(activeReadinessItems.flatMap((item) => item.scopes.missingForBotSmoke));
  const missingDataPlaneScopes = uniqueStrings(activeReadinessItems.flatMap((item) =>
    item.scopes.missingForDataPlaneSmoke
  ));
  const smokeHarness = buildFeishuSmokeHarnessSummary({
    workspaceId: readiness.workspaceId,
    integrationId: setupCandidate?.id,
    appUrl: input.appUrl,
  });
  const appSetup = buildFeishuOpenPlatformSetupSummary({
    hasIntegration: hasActiveIntegration,
    hasAppUrl: Boolean(smokeHarness.appUrl),
    callbackUrl: smokeHarness.callbackUrl,
    requiredCredentialFields: resolveFeishuCliOpenPlatformRequiredCredentialFields(setupCandidate),
  });
  const runtimeSetup = buildFeishuRuntimeSetupSummary(input.runtimeEnv);
  const workerHarness = buildFeishuWorkerHarnessSummary({
    workspaceId: readiness.workspaceId,
    integrationId: webSocketCandidate?.id,
  });
  const setupIntegrationFlag = setupCandidate?.id ?? FEISHU_CLI_PLACEHOLDERS.integrationId;
  const credentialEncryptionReady = runtimeSetup.credentialEncryption.status === "ready";
  const credentialEncryptionIssues = credentialEncryptionReady
    ? []
    : [runtimeSetup.credentialEncryption.issue ?? `credential_encryption_${runtimeSetup.credentialEncryption.status}`];
  const evidenceGates = buildFeishuSmokePlanEvidenceGates({
    hasWebSocketIntegration: activeReadinessItems.some((item) => item.transportMode === "websocket_worker"),
    openApiEvidencePath: smokeHarness.evidencePath,
    botAddedPayloadEvidencePath: smokeHarness.botAddedPayloadEvidencePath,
  });
  const dataPlaneIntegrationFlag = dataPlaneCandidate?.id ?? setupIntegrationFlag;
  const dataPlaneSmokeCommands = buildFeishuDataPlaneSmokeCommands({
    workspaceId: readiness.workspaceId,
    integrationId: dataPlaneIntegrationFlag,
  });
  const sourceIntegrationsById = new Map(sourceIntegrations.map((integration) => [integration.id, integration]));
  const activeNativeAgentBotReadinessItems = nativeAgentBotReadinessSource.integrations.filter((item) =>
    item.status === "active"
  );
  const agentChannelAccessCandidate = activeNativeAgentBotReadinessItems.find((item) =>
    hasNonEmptyString(item.agentId) &&
    isFeishuNativeAgentBotSmokeReady(item, sourceIntegrationsById.get(item.id))
  ) ?? activeNativeAgentBotReadinessItems.find((item) => hasNonEmptyString(item.agentId));
  const externalGuestPolicyCommands = buildFeishuExternalGuestPolicySmokeCommands({
    workspaceId: readiness.workspaceId,
    integrationId: botCandidate?.id ?? setupIntegrationFlag,
    agentId: botCandidate?.agentId,
  });
  const agentChannelAccessCommands = buildFeishuAgentChannelAccessSmokeCommands({
    workspaceId: readiness.workspaceId,
    integrationId: agentChannelAccessCandidate?.id ?? botCandidate?.id ?? setupIntegrationFlag,
    agentId: agentChannelAccessCandidate?.agentId ?? botCandidate?.agentId,
  });
  const finalEvidenceReady = readyForBot && readyForDataPlane && hasSecondAgentBot;
  const finalEvidenceIssues = finalEvidenceReady
    ? []
    : uniqueStrings([
      ...botIssues,
      ...dataPlaneIssues,
      ...(hasSecondAgentBot ? [] : nativeAgentBotReadiness.issues),
    ]);

  const steps: FeishuSmokePlanStep[] = [
      {
        id: "configure_credential_encryption_key",
        area: "setup",
        title: "Configure DofeAgent credential encryption key",
        status: credentialEncryptionReady ? "done" : "pending",
        detail: credentialEncryptionReady
          ? `DofeAgent credential encryption key is configured via ${runtimeSetup.credentialEncryption.configuredEnvName}.`
          : "Set a base64-encoded 32-byte DofeAgent credential encryption key before creating a Feishu integration from CLI.",
        command: credentialEncryptionReady
          ? undefined
          : "export DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)",
        issues: credentialEncryptionIssues,
      },
      {
        id: "prepare_feishu_create_env",
        area: "setup",
        title: "Prepare Feishu agent bot env file",
        status: hasActiveIntegration ? "done" : "pending",
        detail: hasActiveIntegration
          ? "An active Feishu agent bot binding already exists; use smoke-env for workspace-specific live smoke resources."
          : hasScopedSourceIntegration
            ? "Existing Feishu records are not usable as active agent bot bindings. Keep the env file ready so you can bind a fresh active DofeAgent agent bot with App ID + App Secret."
            : "Create scripts/feishu/.env from the checked-in template, then replace the Feishu app credential placeholders before binding an DofeAgent agent to its Feishu bot.",
        command: hasActiveIntegration
          ? undefined
          : "test -f scripts/feishu/.env || cp scripts/feishu/env.example scripts/feishu/.env",
        issues: hasActiveIntegration ? [] : activeIntegrationIssues,
      },
      {
        id: "create_disposable_feishu_apps",
        area: "setup",
        title: "Create disposable Feishu app set for native smoke",
        status: hasSecondAgentBot ? "done" : "pending",
        detail: hasSecondAgentBot
          ? "Found two Phase 6-ready active DofeAgent agent bot bindings backed by distinct Feishu apps and distinct DofeAgent agents."
          : "In Feishu Open Platform, create two disposable custom apps in the same test tenant, such as Codex Bot and HermesAgent Bot. Enable bot capability, subscribe to im.message.receive_v1, im.chat.member.bot.added_v1, and card.action.trigger, grant bot plus Docs/Sheets/Base scopes, install or publish both apps, then bind each app to a different DofeAgent agent.",
        issues: hasSecondAgentBot ? [] : nativeAgentBotReadiness.issues,
      },
      {
        id: "bind_feishu_agent_bot",
        area: "setup",
        title: "Bind one DofeAgent agent to its Feishu bot",
        status: hasActiveIntegration ? "done" : credentialEncryptionReady ? "pending" : "blocked",
        detail: hasActiveIntegration
          ? `Found ${activeReadinessItems.length} active Feishu agent bot binding record(s) in this workspace.`
          : hasScopedSourceIntegration
            ? "Feishu records exist, but none are usable active agent bot bindings. Bind a concrete DofeAgent agent to its Feishu bot before live smoke."
          : "Create a Feishu custom app for a specific DofeAgent agent, then bind it with App ID + App Secret. WebSocket worker is the default quick start; EventCallback verification token/encrypt key stay in advanced setup.",
        command: hasActiveIntegration
          ? undefined
          : `dofe-agent integrations feishu bind-agent-bot --workspace-id ${readiness.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
        issues: hasActiveIntegration
          ? []
          : uniqueStrings([...activeIntegrationIssues, ...credentialEncryptionIssues]),
      },
      {
        id: "configure_app_credentials",
        area: "setup",
        title: "Configure agent bot app credentials",
        status: prereqStatus(hasActiveIntegration, hasConfiguredAppCredentials),
        detail: hasConfiguredAppCredentials
          ? "DofeAgent has a Feishu app id plus required secret configuration for at least one agent bot binding."
          : "For quick start, save only App ID and App Secret on the agent bot binding. Add verification token and encrypt key only when using EventCallback.",
        issues: hasActiveIntegration
          ? collectSetupIssues(setupCandidate, ["app_id_missing", "credentials_incomplete"])
          : activeIntegrationIssues,
      },
      {
        id: "configure_bot_events_and_scopes",
        area: "setup",
        title: "Configure bot events and required scopes",
        status: prereqStatus(hasActiveIntegration, hasBotAndDataPlaneScopes),
        detail: "Enable im.message.receive_v1, im.chat.member.bot.added_v1, bot permissions, and Docs/Sheets/Base scopes in Feishu Open Platform.",
        issues: hasActiveIntegration
          ? [...missingBotScopes, ...missingDataPlaneScopes].map((scope) => `missing_scope:${scope}`)
          : activeIntegrationIssues,
      },
      {
        id: "check_connection_health",
        area: "setup",
        title: "Run DofeAgent health check",
        status: prereqStatus(hasActiveIntegration, hasHealthChecked),
        detail: "Run Test connection in settings or the readiness CLI so manual smoke is not attempted against unknown health.",
        command: `dofe-agent integrations feishu readiness --workspace-id ${readiness.workspaceId} --json`,
        issues: hasActiveIntegration
          ? collectSetupIssues(setupCandidate, ["health_not_checked", "health_error", "health_degraded"])
          : activeIntegrationIssues,
      },
      {
        id: "prepare_live_smoke_env",
        area: "setup",
        title: "Prepare isolated Feishu smoke env file",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "Copy the checked-in template, fill it with disposable Feishu smoke resources, and keep the resulting env file out of git.",
        command: smokeHarness.prepareEnvCommand,
        issues: activeIntegrationIssues,
      },
      {
        id: "check_live_smoke_env",
        area: "setup",
        title: "Check isolated Feishu smoke env file",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "Validate that the live smoke env has real app, callback, IM, Docs, Sheets, and Base values before calling Feishu.",
        command: smokeHarness.checkEnvCommand,
        issues: activeIntegrationIssues,
      },
      {
        id: "bind_feishu_chat",
        area: "bot",
        title: "Manual fallback: bind Feishu group to an DofeAgent channel",
        status: prereqStatus(hasActiveIntegration, hasChannelBinding),
        detail: "TODO120's primary path is automatic: adding the agent bot to a Feishu group should create or reuse the DofeAgent channel. Use this manual binding only as a fallback when auto-provisioning is disabled or under admin review.",
        command: `dofe-agent integrations feishu bind-channel --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --chat-id ${FEISHU_CLI_PLACEHOLDERS.feishuChatId} --json`,
        issues: hasActiveIntegration ? collectSetupIssues(botCandidate, ["channel_binding_missing"]) : activeIntegrationIssues,
      },
      {
        id: "bind_feishu_user",
        area: "bot",
        title: "Bind Feishu user to an DofeAgent user",
        status: prereqStatus(hasActiveIntegration, hasUserBinding),
        detail: "Bind the Feishu sender to a workspace member so inbound messages remain governed by DofeAgent permissions.",
        command: `dofe-agent integrations feishu bind-user --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --user-id ${FEISHU_CLI_PLACEHOLDERS.dofeAgentUserId} --open-id ${FEISHU_CLI_PLACEHOLDERS.feishuOpenId} --json`,
        issues: hasActiveIntegration ? collectSetupIssues(botCandidate, ["user_binding_missing"]) : activeIntegrationIssues,
      },
      {
        id: "run_bot_readiness_gate",
        area: "bot",
        title: "Pass local bot smoke readiness gate",
        status: readyForBot ? "done" : "blocked",
        detail: readyForBot
          ? `Bot smoke prerequisites pass for ${formatIntegrationLabel(botCandidate)}.`
          : "Local prerequisites are incomplete; do not treat live bot smoke as meaningful yet.",
        command: `dofe-agent integrations feishu readiness --workspace-id ${readiness.workspaceId} --strict --require bot --json`,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_bot_message_reply",
        area: "bot",
        title: "Live smoke: @agent-specific Feishu bot and verify reply",
        status: readyForBot ? "pending" : "blocked",
        detail: "In the mapped Feishu group, mention the concrete agent bot, such as @Codex Bot, without any /agent command. Verify DofeAgent records agentId + botBindingId, queues the internal task, creates a sent Feishu agent_reply outbox with safe chat/thread context, and replies from the same Feishu bot identity in the same thread.",
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_agent_bot_direct_mention",
        area: "bot",
        title: "Live smoke: direct @agent bot route evidence",
        status: readyForBot ? "pending" : "blocked",
        detail: "From a bound Feishu user, directly @ the agent-specific bot and verify DofeAgent records actorType=user, actorUserId, safe audit references, the concrete agentId, botBindingId, task, and message evidence without using /agent routing text.",
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_agent_bot_channel_auto_provision",
        area: "bot",
        title: "Live smoke: agent bot auto-provisions channel",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "Add the agent's Feishu bot to a new Feishu group and verify DofeAgent creates or binds the channel automatically with provisionSource=bot_added, safe chat reference metadata, agent membership, and a confirmation card.",
        issues: activeIntegrationIssues,
      },
      {
        id: "verify_real_bot_added_payload_sample",
        area: "bot",
        title: "Verify real Feishu bot-added callback payload shape",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "Save one raw bot-added callback JSON from the disposable Feishu tenant/app under runtime-output, then run the offline verifier. It must recognize the event as bot-added, resolve the chat descriptor, and print only safe field sources, hashes, references, lengths, and booleans without raw Feishu ids or group names.",
        command: smokeHarness.verifyBotAddedPayloadCommand,
        issues: activeIntegrationIssues,
      },
      {
        id: "live_agent_bot_first_message_auto_provision",
        area: "bot",
        title: "Live smoke: first mentioned message provisions channel",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "In a Feishu group that has no DofeAgent channel binding yet, send the first message mentioning the concrete agent bot. Verify DofeAgent records provisionSource=first_message, creates or binds the channel according to policy, and does not require a /agent command.",
        issues: activeIntegrationIssues,
      },
      {
        id: "bind_second_feishu_agent_bot",
        area: "setup",
        title: "Bind second DofeAgent agent to its Feishu bot",
        status: hasSecondAgentBot ? "done" : hasIntegration && credentialEncryptionReady ? "pending" : "blocked",
        detail: hasSecondAgentBot
          ? `Found ${nativeAgentBotReadiness.readyAgentBotBindingCount} Phase 6-ready agent-scoped Feishu bot bindings across distinct DofeAgent agents and Feishu apps.`
          : "Create a second active Feishu custom app, such as HermesAgent Bot, and bind it to a different DofeAgent agent with app credentials, bot scopes, healthy/degraded health, and no unresolved outbox failures before testing same-group reuse and thread collaboration.",
        command: hasSecondAgentBot
          ? undefined
          : `dofe-agent integrations feishu bind-agent-bot --workspace-id ${readiness.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.secondAgentName} --env-file scripts/feishu/.env --app-id-env FEISHU_SECOND_AGENT_APP_ID --app-secret-env FEISHU_SECOND_AGENT_APP_SECRET --json`,
        issues: hasSecondAgentBot
          ? []
          : hasIntegration
            ? uniqueStrings([...nativeAgentBotReadiness.issues, ...credentialEncryptionIssues])
            : ["integration_missing", ...credentialEncryptionIssues],
      },
      {
        id: "live_multi_agent_bot_channel_reuse",
        area: "bot",
        title: "Live smoke: second agent bot reuses channel",
        status: hasSecondAgentBot ? "pending" : "blocked",
        detail: "After the second agent bot binding exists, add that bot to the same Feishu group and verify DofeAgent reuses the existing channel, adds only that agent membership, and records linkedFromBindingId plus different linkedFromAgentId/linkedFromBotBindingId metadata instead of creating a duplicate channel.",
        issues: hasSecondAgentBot ? [] : nativeAgentBotReadiness.issues,
      },
      {
        id: "live_multi_agent_thread_collaboration",
        area: "bot",
        title: "Live smoke: second agent bot joins an active thread",
        status: readyForBot && hasSecondAgentBot ? "pending" : "blocked",
        detail: "Mention one agent-specific Feishu bot in a mapped group thread, then mention the second agent bot in that same Feishu thread. Verify DofeAgent keeps separate thread bindings, records threadCollaboration=true with collaborator agent ids and bot binding ids, and sends a collaboration card that matches the active thread binding without raw Feishu ids.",
        issues: readyForBot && hasSecondAgentBot
          ? []
          : uniqueStrings([
            ...botIssues,
            ...(hasSecondAgentBot ? [] : nativeAgentBotReadiness.issues),
          ]),
      },
      {
        id: "live_feishu_thread_task_binding",
        area: "bot",
        title: "Live smoke: Feishu thread binds to DofeAgent task",
        status: readyForBot ? "pending" : "blocked",
        detail: "Mention the agent bot in a Feishu thread and verify DofeAgent records the thread binding with taskQueueId, dofeAgentMessageId, agentId, botBindingId, and a safe thread reference.",
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_feishu_thread_continuation",
        area: "bot",
        title: "Live smoke: Feishu thread follow-up continues",
        status: readyForBot ? "pending" : "blocked",
        detail: "After a mentioned agent bot message creates a Feishu thread binding, send a follow-up in the same Feishu thread without mentioning the bot and verify DofeAgent records threadContinuation=true with the same active thread binding reference, taskQueueId, dofeAgentMessageId, agentId, and botBindingId.",
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_external_guest_agent_bot_mention",
        area: "bot",
        title: "Live smoke: unbound Feishu user routes as external guest",
        status: readyForBot ? "pending" : "blocked",
        detail: "From a Feishu user that is not bound to DofeAgent, mention the agent bot and verify DofeAgent dispatches actorType=external_guest with permissionProfile=channel_context_only, no userId/actorUserId, task/message dispatch, safe audit references, no real workspace member, and no raw Feishu user ids.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_external_guest_reply_all",
        area: "bot",
        title: "Live smoke: reply_all external guest dispatch",
        status: readyForBot ? "pending" : "blocked",
        detail: `Temporarily set the agent bot external guest policy to reply_all, send an unbound Feishu message without mentioning the bot, and verify DofeAgent still routes it to the bot's agent as channel_context_only external_guest. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.replyAllCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_external_guest_identity_required",
        area: "bot",
        title: "Live smoke: external guest must bind identity",
        status: readyForBot ? "pending" : "blocked",
        detail: `Temporarily set the agent bot external guest policy to require_identity, mention the bot from an unbound Feishu user, and verify DofeAgent records the require_identity decision plus the identity-binding notice. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_external_guest_reply_disabled",
        area: "bot",
        title: "Live smoke: external guest replies can be disabled",
        status: readyForBot ? "pending" : "blocked",
        detail: `Temporarily set the agent bot external guest policy to ignore with permissionProfile=none, mention the bot from an unbound Feishu user, and verify DofeAgent records the ignore decision without dispatching a task or sending a reply. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.ignoreCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_unmentioned_guest_message_ignored",
        area: "bot",
        title: "Live smoke: unmentioned guest message is ignored",
        status: readyForBot ? "pending" : "blocked",
        detail: "With reply_on_mention enabled, send an unbound Feishu group message that does not mention the agent bot and verify DofeAgent records the bot-mention-required decision without dispatching.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_bound_user_data_operation",
        area: "data-plane",
        title: "Live smoke: bound Feishu user actor audit",
        status: readyForBot && readyForDataPlane ? "pending" : "blocked",
        detail: "From a Feishu user that is bound to an DofeAgent user, ask the concrete agent bot to use a bound Doc/Sheet/Base resource. Verify the data operation records governanceContext.actorType=user, actorUserId, agentId, botBindingId, and safe audit references without raw Feishu ids.",
        command: dataPlaneSmokeCommands.liveDocReadCommand,
        issues: readyForBot && readyForDataPlane ? [] : uniqueStrings([...botIssues, ...dataPlaneIssues]),
      },
      {
        id: "live_external_guest_write_denied",
        area: "data-plane",
        title: "Live smoke: external guest write requires identity",
        status: readyForBot && readyForDataPlane ? "pending" : "blocked",
        detail: `From an unbound Feishu user, ask the concrete agent bot to write a bound smoke Sheet/Base resource. Verify DofeAgent records external_guest governance on a bound write run with permissionProfile=none or permissionProfile=channel_context_only, refuses the final Feishu write with require_identity, sends the identity-binding notice, and does not create a real workspace member. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
        issues: readyForBot && readyForDataPlane ? [] : uniqueStrings([...botIssues, ...dataPlaneIssues]),
      },
      {
        id: "live_external_guest_read_guest_readable",
        area: "data-plane",
        title: "Live smoke: external guest reads guest-readable resource",
        status: readyForBot && readyForDataPlane ? "pending" : "blocked",
        detail: "From an unbound Feishu user, ask the concrete agent bot to read a guest-readable Doc/Sheet/Base resource bound to the current channel. Verify the run records external_guest governance, permissionProfile=channel_context_only, and externalGuestResourceAccess=guest_readable_current_channel.",
        command: [
          externalGuestPolicyCommands.replyOnMentionCommand,
          dataPlaneSmokeCommands.liveDocReadCommand,
        ].join("\n"),
        issues: readyForBot && readyForDataPlane ? [] : uniqueStrings([...botIssues, ...dataPlaneIssues]),
      },
      {
        id: "live_agent_channel_policy_disabled",
        area: "bot",
        title: "Live smoke: disabled agent/channel policy blocks replies",
        status: readyForBot ? "pending" : "blocked",
        detail: `Disable the agent's channel-member access, mention the Feishu agent bot, and verify DofeAgent records the policy denial without writing a channel message, queueing a task, or sending a bot reply. Restore after this smoke step with: ${agentChannelAccessCommands.restoreCommand}`,
        command: agentChannelAccessCommands.disableCommand,
        issues: readyForBot ? [] : botIssues,
      },
      {
        id: "live_agent_bound_doc_summary",
        area: "data-plane",
        title: "Live smoke: agent bot summarizes a bound Feishu Doc",
        status: readyForBot && readyForDataPlane ? "pending" : "blocked",
        detail: "In the mapped Feishu group, ask the concrete agent bot, such as @Codex Bot, to summarize the already-bound Feishu Doc. Verify the agent uses DofeAgent-scoped lark-cli/resource context, creates normal task/reply evidence, and sends the answer back to the Feishu thread.",
        issues: readyForBot && readyForDataPlane ? [] : uniqueStrings([...botIssues, ...dataPlaneIssues]),
      },
      {
        id: "run_websocket_worker_dry_run",
        area: "worker",
        title: "Self-hosted smoke: validate WebSocket worker selection",
        status: readyForWorkerSmoke ? "pending" : "blocked",
        detail: "Dry-run the self-hosted worker on websocket_worker integrations before opening a live WebSocket connection.",
        command: workerHarness.dryRunCommand,
        issues: workerIssues,
      },
      {
        id: "live_websocket_receive_message",
        area: "worker",
        title: "Live smoke: receive Feishu message through WebSocket worker",
        status: readyForWorkerSmoke ? "pending" : "blocked",
        detail: "Start the worker in a self-hosted environment, mention the concrete agent bot in a mapped Feishu group, then trigger one Sheet/Base approval card action from Feishu; verify both bypass the HTTP callback route while still creating the DofeAgent task/reply and approval execution.",
        command: workerHarness.startCommand,
        issues: workerIssues,
      },
      {
        id: "live_websocket_worker_restart",
        area: "worker",
        title: "Live smoke: restart WebSocket worker and verify recovery",
        status: readyForWorkerSmoke ? "pending" : "blocked",
        detail: "Restart the deployed worker, verify it reconnects, then send another Feishu message and confirm processing/outbox still work. The final evidence gate expects two correlated WebSocket replies: one before restart and one after restart.",
        command: workerHarness.systemdRestartCommand,
        issues: workerIssues,
      },
      {
        id: "bind_feishu_doc_sheet_base",
        area: "data-plane",
        title: "Bind Feishu Doc, Sheet, and Base resources",
        status: prereqStatus(hasActiveIntegration, hasDocBinding && hasSheetBinding && hasBaseBinding),
        detail: "Bind one Feishu Doc, one Sheet, and one Base table to DofeAgent resources for data-plane smoke.",
        command: [
          `dofe-agent integrations feishu bind-resource --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --type doc --resource ${FEISHU_CLI_PLACEHOLDERS.docResource} --dofe-agent-type channel_document --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
          `dofe-agent integrations feishu bind-resource --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --type sheet --resource ${FEISHU_CLI_PLACEHOLDERS.sheetResource} --dofe-agent-type data_table --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
          `dofe-agent integrations feishu bind-resource --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --type base_table --resource ${FEISHU_CLI_PLACEHOLDERS.baseResource} --dofe-agent-type data_table --channel ${FEISHU_CLI_PLACEHOLDERS.dofeAgentChannel} --allow-write --json`,
        ].join("\n"),
        issues: hasActiveIntegration
          ? collectDataPlaneBindingIssues({
            hasDocBinding,
            hasAnyDocBinding,
            hasSheetBinding,
            hasAnySheetBinding,
            hasBaseBinding,
            hasAnyBaseBinding,
            hasBaseReadyBinding,
          })
          : activeIntegrationIssues,
      },
      {
        id: "run_data_plane_readiness_gate",
        area: "data-plane",
        title: "Pass local data-plane smoke readiness gate",
        status: readyForDataPlane ? "done" : "blocked",
        detail: readyForDataPlane
          ? `Docs/Sheets/Base prerequisites pass for ${formatIntegrationLabel(dataPlaneCandidate)}.`
          : "Data-plane prerequisites are incomplete; live Doc/Sheet/Base smoke would be inconclusive.",
        command: `dofe-agent integrations feishu readiness --workspace-id ${readiness.workspaceId} --strict --require data-plane --json`,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_doc_read",
        area: "data-plane",
        title: "Live smoke: read bound Feishu Doc",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: "Read the bound Feishu Doc through DofeAgent and verify the operation run uses an active resource binding, records Feishu governance context with agentId, botBindingId, and actor provenance, stores only safe resource references plus a safe summary, and never stores raw resource tokens.",
        command: dataPlaneSmokeCommands.liveDocReadCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_doc_write_with_approval",
        area: "data-plane",
        title: "Live smoke: approve a small Doc write",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: "Create a governed Doc append approval from CLI, review the returned approval id through the same DofeAgent approval execution path, then verify payload hash check, Feishu write, and safe result summary.",
        command: dataPlaneSmokeCommands.liveDocWriteCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_sheet_read",
        area: "data-plane",
        title: "Live smoke: read bound Feishu Sheet",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: "Read a small bound Sheet range through DofeAgent and verify the operation run uses an active resource binding, records Feishu governance context with agentId, botBindingId, and actor provenance, stores only safe resource references plus a safe summary, and never stores raw resource tokens.",
        command: dataPlaneSmokeCommands.liveSheetReadCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_sheet_write_with_approval",
        area: "data-plane",
        title: "Live smoke: approve a small Sheet write",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: "Create a governed Sheet write approval from CLI, review the returned approval id through the same DofeAgent approval execution path, then verify payload hash check, Feishu write, DofeAgent data table sync, and safe result summary.",
        command: dataPlaneSmokeCommands.liveSheetWriteCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_base_preview_and_update",
        area: "data-plane",
        title: "Live smoke: preview and update one Base record",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: "Read Base records through an active resource binding with Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens; then create a governed Base update approval from CLI, review the returned approval id through the same DofeAgent approval execution path, and verify approvalId, payload hash check, Feishu Base update, operation run, and DofeAgent data table sync succeed.",
        command: dataPlaneSmokeCommands.liveBaseCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "run_openapi_live_smoke_harness",
        area: "data-plane",
        title: "Live smoke: run isolated Feishu callback and OpenAPI harness",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: `Run the throwaway smoke harness after check-env passes. It must pass ${smokeHarness.requiredLiveSteps} live checks, including destructive writes for ${smokeHarness.destructiveLiveStepNames.join(", ")}, before saving the redacted OpenAPI evidence artifact consumed by the final DofeAgent evidence gate. Regenerate it if final evidence will run more than 24 hours later.`,
        command: smokeHarness.strictLiveCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "verify_live_smoke_evidence",
        area: "data-plane",
        title: "Verify redacted Feishu live smoke evidence",
        status: readyForDataPlane ? "pending" : "blocked",
        detail: `Validate that the saved evidence artifact came from a strict live run, was generated within 24 hours, includes all ${smokeHarness.requiredLiveSteps} required IM/Docs/Sheets/Base checks plus ${smokeHarness.destructiveLiveChecks} destructive write checks, and keeps resource tokens redacted.`,
        command: smokeHarness.verifyEvidenceCommand,
        issues: readyForDataPlane ? [] : dataPlaneIssues,
      },
      {
        id: "live_failure_visibility",
        area: "failure",
        title: "Live smoke: verify visible provider failure",
        status: hasActiveIntegration ? "pending" : "blocked",
        detail: "Temporarily revoke a Feishu scope, use a wrong secret, or stop Feishu API access, then refresh health and verify a failed outbox/data-operation row plus degraded/error health are visible with agent/bot and safe chat/resource context, without leaking secrets.",
        command: `dofe-agent integrations feishu health-check --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --json`,
        issues: activeIntegrationIssues,
      },
      {
        id: "verify_dofe-agent_live_evidence",
        area: "failure",
        title: "Verify DofeAgent-side Feishu live smoke evidence",
        status: finalEvidenceReady ? "pending" : "blocked",
        detail: "After live native agent bot, guest-policy, data-plane, worker when using websocket_worker, and failure smoke, verify local DofeAgent DB evidence without exposing external ids or resource tokens. Native evidence requires two Phase 6-ready agent bot bindings, agent-specific bot routing, auto-provisioning, multi-agent channel reuse, thread/task binding, thread continuation, thread collaboration with sent card proof, bot sender loop guard, and disabled-policy no-reply proof; guest evidence requires allow, reply_all, require_identity, sent identity-binding notice, ignore, and mention-required decisions. Local DofeAgent evidence rows plus OpenAPI and bot-added artifacts must all be generated within 24 hours.",
        command: `dofe-agent integrations feishu evidence --workspace-id ${readiness.workspaceId} --integration ${setupIntegrationFlag} --openapi-evidence ${smokeHarness.evidencePath} --bot-added-payload-evidence ${smokeHarness.botAddedPayloadEvidencePath} --strict --require all`,
        issues: finalEvidenceIssues,
      },
  ];

  return {
    workspaceId: readiness.workspaceId,
    requiredReadiness: readiness.requiredReadiness,
    integrationCount: readiness.integrationCount,
    strictSatisfied: readiness.strictSatisfied,
    selectedBotIntegrationId: botCandidate?.id,
    selectedDataPlaneIntegrationId: dataPlaneCandidate?.id,
    selectedWorkerIntegrationId: workerCandidate?.readyForWorkerSmoke ? workerCandidate.id : undefined,
    appSetup,
    runtimeSetup,
    smokeHarness,
    workerHarness,
    evidenceGates,
    readinessSummary: {
      readyForBotSmokeCount: readiness.readyForBotSmokeCount,
      readyForDataPlaneSmokeCount: readiness.readyForDataPlaneSmokeCount,
      readyForWorkerSmokeCount: readiness.readyForWorkerSmokeCount,
    },
    blockers: buildFeishuSmokePlanBlockers(steps),
    steps,
  };
}
export function getFeishuSmokePlanExitCode(
  report: Pick<FeishuSmokePlanReport, "strictSatisfied">,
  input: { strict: boolean },
): number {
  return input.strict && !report.strictSatisfied ? 1 : 0;
}
export function formatFeishuSmokePlanCommandText(report: FeishuSmokePlanReport): string {
  const lines = [
    "DofeAgent Feishu smoke plan",
    `Workspace: ${report.workspaceId}`,
    `Required readiness: ${report.requiredReadiness}`,
    `Strict readiness satisfied: ${report.strictSatisfied ? "yes" : "no"}`,
    `Integrations: ${report.integrationCount}`,
    `Ready counts: bot=${report.readinessSummary.readyForBotSmokeCount}, data-plane=${report.readinessSummary.readyForDataPlaneSmokeCount}, worker=${report.readinessSummary.readyForWorkerSmokeCount}`,
  ];
  if (report.selectedBotIntegrationId || report.selectedDataPlaneIntegrationId || report.selectedWorkerIntegrationId) {
    lines.push(
      `Selected: bot=${report.selectedBotIntegrationId ?? "missing"}, data-plane=${report.selectedDataPlaneIntegrationId ?? "missing"}, worker=${report.selectedWorkerIntegrationId ?? "missing"}`,
    );
  }

  lines.push("", "Blockers:");
  if (report.blockers.length === 0) {
    lines.push("- none");
  } else {
    for (const blocker of report.blockers.slice(0, 8)) {
      lines.push(
        `- ${blocker.issue} (${blocker.severity}; ${blocker.affectedStepCount} affected step${blocker.affectedStepCount === 1 ? "" : "s"})`,
        `  first: ${blocker.firstStepTitle} [${blocker.firstStepId}]`,
        `  next: ${blocker.nextAction}`,
      );
    }
    if (report.blockers.length > 8) {
      lines.push(`- ... ${report.blockers.length - 8} more blocker(s); rerun with --json for the full list.`);
    }
  }

  const nextSteps = report.steps.filter((step) => step.status !== "done").slice(0, 6);
  lines.push("", "Next steps:");
  if (nextSteps.length === 0) {
    lines.push("- all local readiness steps are done; continue with live Feishu smoke.");
  } else {
    for (const step of nextSteps) {
      lines.push(`- [${step.status}] ${step.title} (${step.id})`);
      if (step.issues && step.issues.length > 0) {
        lines.push(`  issues: ${step.issues.join(", ")}`);
      }
      if (step.command) {
        lines.push(`  command: ${step.command}`);
      }
    }
  }

  const finalEvidenceStep = report.steps.find((step) => step.id === "verify_dofe-agent_live_evidence");
  lines.push(
    "",
    "Smoke commands:",
    `- prepare env: ${report.smokeHarness.prepareEnvCommand}`,
    `- check env: ${report.smokeHarness.checkEnvCommand}`,
    `- strict live: ${report.smokeHarness.strictLiveCommand}`,
    `- verify OpenAPI evidence: ${report.smokeHarness.verifyEvidenceCommand}`,
    `- verify bot-added payload: ${report.smokeHarness.verifyBotAddedPayloadCommand}`,
  );
  if (finalEvidenceStep?.command) {
    lines.push(`- final DofeAgent evidence: ${finalEvidenceStep.command}`);
  }
  lines.push("", "Use --json for machine-readable blockers, evidence gates, and the full step list.");

  return lines.join("\n");
}
export function buildFeishuSmokePlanBlockers(steps: readonly FeishuSmokePlanStep[]): FeishuSmokePlanBlocker[] {
  const blockers = new Map<string, FeishuSmokePlanBlocker>();
  const issueOrder = new Map<string, number>();
  steps.forEach((step, stepIndex) => {
    if (step.status === "done") {
      return;
    }
    for (const [issueIndex, issue] of (step.issues ?? []).entries()) {
      const existing = blockers.get(issue);
      if (existing) {
        existing.affectedStepCount += 1;
        if (step.status === "blocked") {
          existing.blockedStepCount += 1;
          existing.severity = "blocked";
        } else {
          existing.pendingStepCount += 1;
        }
        continue;
      }
      issueOrder.set(issue, stepIndex * 1000 + issueIndex);
      blockers.set(issue, {
        issue,
        severity: step.status === "blocked" ? "blocked" : "pending",
        affectedStepCount: 1,
        blockedStepCount: step.status === "blocked" ? 1 : 0,
        pendingStepCount: step.status === "pending" ? 1 : 0,
        firstStepId: step.id,
        firstStepTitle: step.title,
        nextAction: describeFeishuSmokePlanIssueNextAction(issue),
      });
    }
  });
  return [...blockers.values()].sort((left, right) =>
    (issueOrder.get(left.issue) ?? Number.MAX_SAFE_INTEGER) -
    (issueOrder.get(right.issue) ?? Number.MAX_SAFE_INTEGER) ||
    right.blockedStepCount - left.blockedStepCount ||
    right.affectedStepCount - left.affectedStepCount ||
    left.issue.localeCompare(right.issue)
  );
}
export function buildFeishuSmokePlanActiveAgentBotIssues(input: {
  scopedIntegrationId?: string;
  scopedSourceIntegrations: readonly ExternalIntegrationRecord[];
  hasActiveAgentBotIntegration: boolean;
}): string[] {
  if (input.hasActiveAgentBotIntegration) {
    return [];
  }
  if (input.scopedIntegrationId && input.scopedSourceIntegrations.length === 0) {
    return ["selected_integration_missing"];
  }
  if (
    input.scopedIntegrationId &&
    input.scopedSourceIntegrations.some((integration) => integration.status !== "active")
  ) {
    return ["selected_integration_not_active"];
  }
  if (
    input.scopedIntegrationId &&
    input.scopedSourceIntegrations.some((integration) => !hasNonEmptyString(integration.agentId))
  ) {
    return ["selected_integration_not_agent_bot"];
  }
  if (input.scopedSourceIntegrations.length === 0) {
    return ["integration_missing"];
  }
  if (!input.scopedSourceIntegrations.some((integration) => integration.status === "active")) {
    return ["integration_not_active"];
  }
  if (!input.scopedSourceIntegrations.some((integration) =>
    integration.status === "active" && hasNonEmptyString(integration.agentId)
  )) {
    return ["active_agent_bot_integration_missing"];
  }
  return ["integration_missing"];
}
export function describeFeishuSmokePlanIssueNextAction(issue: string): string {
  if (issue.startsWith("missing_scope:")) {
    const scope = issue.slice("missing_scope:".length);
    return `Grant the Feishu app scope ${scope} in Open Platform, publish/install the app, then rerun health/readiness.`;
  }
  switch (issue) {
    case "credential_encryption_key_missing":
      return "Set DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY or DOFE_AGENT_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY to a base64-encoded 32-byte key before binding Feishu app credentials.";
    case "credential_encryption_key_invalid":
      return "Replace the configured DofeAgent credential encryption key with a valid base64-encoded 32-byte key before binding Feishu app credentials.";
    case "integration_missing":
      return "Create or bind an active Feishu agent bot integration in DofeAgent with App ID and App Secret.";
    case "integration_not_active":
      return "Re-enable the intended Feishu agent bot binding or create a fresh active binding before live smoke.";
    case "active_agent_bot_integration_missing":
      return "Bind a Feishu custom app to a concrete DofeAgent agent; active workspace-level Feishu records cannot be used as TODO120 agent bot evidence.";
    case "selected_integration_missing":
      return "Rerun smoke-plan without --integration or pass an existing Feishu agent bot binding id.";
    case "selected_integration_not_active":
      return "Select an active Feishu integration or re-enable the selected binding before generating smoke env values.";
    case "selected_integration_not_agent_bot":
      return "Select an active agent-scoped Feishu bot binding or bind this Feishu app to a concrete DofeAgent agent before live smoke.";
    case "app_url_missing":
      return "Pass --app-url with the public DofeAgent HTTPS URL so callback URLs can be generated.";
    case "app_id_missing":
      return "Save the Feishu App ID on the selected agent bot binding.";
    case "credentials_incomplete":
      return "Save the required Feishu app secret, and the verification token when using EventCallback.";
    case "health_not_checked":
      return "Run Feishu health-check or readiness after credentials and scopes are configured.";
    case "health_error":
      return "Fix the Feishu app credentials/scopes or OpenAPI access, then rerun health-check.";
    case "health_degraded":
      return "Review the degraded Feishu health result, fix missing scopes or connectivity, then rerun health-check.";
    case "channel_binding_missing":
      return "Add the Feishu bot to a group to auto-provision a channel, or use bind-channel as a manual fallback.";
    case "user_binding_missing":
      return "Bind at least one Feishu sender to an DofeAgent user for bound-user smoke and audit evidence.";
    case "doc_resource_binding_missing":
      return "Bind a Feishu Doc to the DofeAgent channel before Docs data-plane smoke.";
    case "doc_resource_write_grant_missing":
      return "Enable write permission on the bound Feishu Doc resource before approved write smoke.";
    case "sheet_resource_binding_missing":
      return "Bind a Feishu Sheet to the DofeAgent channel before Sheets data-plane smoke.";
    case "sheet_resource_write_grant_missing":
      return "Enable write permission on the bound Feishu Sheet resource before approved write smoke.";
    case "base_resource_binding_missing":
      return "Bind a Feishu Base table to the DofeAgent channel before Base data-plane smoke.";
    case "base_resource_app_token_missing":
      return "Add the Base app token/table metadata required for a data-plane-ready Base binding.";
    case "base_resource_write_grant_missing":
      return "Enable write permission on the bound Feishu Base table before approved mutation smoke.";
    case "websocket_worker_integration_missing":
      return "Use an active websocket_worker Feishu agent bot binding before running WebSocket worker smoke.";
    case "second_agent_bot_missing":
      return "Create a second disposable Feishu app and bind it to a different DofeAgent agent.";
    case "second_agent_bot_not_ready":
      return "Make two agent-scoped Feishu bot bindings Phase 6-ready: active, credentialed, health-checked, scoped, and without unresolved outbox failures.";
    case "second_agent_bot_distinct_agent_missing":
      return "Bind the second Feishu bot to a different DofeAgent agent.";
    case "second_agent_bot_distinct_app_missing":
      return "Use a different Feishu App ID for the second DofeAgent agent bot.";
    default:
      return "Resolve this smoke-plan issue, rerun readiness, then regenerate smoke-plan.";
  }
}
export function buildFeishuSmokePlanEvidenceGates(input: {
  hasWebSocketIntegration: boolean;
  openApiEvidencePath: string;
  botAddedPayloadEvidencePath: string;
}): FeishuSmokePlanEvidenceGate[] {
  return [
    {
      key: "bot_reply",
      required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.botReply,
    },
    {
      key: "native_agent_bot",
      required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.nativeAgentBot,
    },
    {
      key: "guest_policy",
      required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.guestPolicy,
    },
    ...(input.hasWebSocketIntegration
      ? [{
        key: "worker_restart" as const,
        required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.workerRestart,
      }, {
        key: "worker_card_action" as const,
        required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.workerCardAction,
      }]
      : []),
    {
      key: "data_plane",
      required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.dataPlane,
    },
    {
      key: "failure_visibility",
      required: FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS.failureVisibility,
    },
    {
      key: "dofe-agent_local_evidence",
      required: "fresh_24h_dofe-agent_local_evidence_rows",
    },
    {
      key: "openapi_artifact",
      required: `fresh_24h_strict_live_artifact:${input.openApiEvidencePath}`,
    },
    {
      key: "bot_added_payload_artifact",
      required: `fresh_24h_bot_added_payload_artifact:${input.botAddedPayloadEvidencePath}`,
    },
  ];
}
export function parseRequiredReadiness(value: string | undefined): FeishuRequiredReadiness {
  if (!value || value === "bot") {
    return "bot";
  }
  if (value === "data-plane" || value === "data_plane" || value === "data") {
    return "data-plane";
  }
  if (value === "worker" || value === "websocket" || value === "websocket-worker") {
    return "worker";
  }
  throw new Error("Invalid --require value. Use bot, data-plane, or worker.");
}
export function parseEvidenceRequirement(value: string | undefined): FeishuEvidenceRequirement {
  if (!value || value === "bot") {
    return "bot";
  }
  if (value === "native" || value === "native-experience" || value === "agent-bot") {
    return "native";
  }
  if (value === "guest-policy" || value === "guest_policy" || value === "external-guest") {
    return "guest-policy";
  }
  if (value === "data-plane" || value === "data_plane" || value === "data") {
    return "data-plane";
  }
  if (value === "worker" || value === "websocket" || value === "websocket-worker") {
    return "worker";
  }
  if (value === "failure" || value === "failures") {
    return "failure";
  }
  if (value === "all") {
    return "all";
  }
  throw new Error("Invalid --require value. Use bot, native, guest-policy, data-plane, worker, failure, or all.");
}
