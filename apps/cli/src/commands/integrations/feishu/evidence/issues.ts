// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：issues。
import type { ExternalIntegrationRecord } from "@dofe-agent/db";
import { uniqueStrings } from "../cli-shared.ts";
import { buildFeishuAgentChannelAccessSmokeCommands, buildFeishuDataPlaneSmokeCommands, buildFeishuExternalGuestPolicySmokeCommands } from "../smoke-env.ts";
import { FEISHU_CLI_PLACEHOLDERS } from "../types.ts";
import type { FeishuEvidenceRemediationStep, FeishuLocalEvidenceFreshnessSummary } from "../types.ts";
import { buildFeishuWorkerHarnessSummary } from "../worker.ts";
import { hasNonEmptyString } from "./core.ts";

export function buildFeishuEvidenceIssues(input: {
  integration: ExternalIntegrationRecord;
  localEvidenceFreshness: FeishuLocalEvidenceFreshnessSummary;
  botSatisfied: boolean;
  nativeExperienceSatisfied: boolean;
  guestPolicySatisfied: boolean;
  dataPlaneSatisfied: boolean;
  workerSatisfied: boolean;
  failureSatisfied: boolean;
  processedInboundEvents: number;
  inboundMessageMappings: number;
  sentOutboxItems: number;
  outboundMessageMappings: number;
  correlatedReplyMappings: number;
  agentBotRouteEvidence: number;
  nativeBotReplyEvidence: number;
  boundUserMentionEvidence: number;
  externalGuestMentionEvidence: number;
  agentChannelPolicyDeniedEvidence: number;
  botSenderLoopGuardEvidence: number;
  externalGuestAllowedEvidence: number;
  externalGuestReplyAllEvidence: number;
  externalGuestRequireIdentityEvidence: number;
  externalGuestIdentityBindingNoticeEvidence: number;
  externalGuestIgnoreEvidence: number;
  externalGuestMentionRequiredEvidence: number;
  autoProvisionedChannelBindings: number;
  botAddedAutoProvisionedChannelBindings: number;
  firstMessageAutoProvisionedChannelBindings: number;
  reusedProviderChannelBindings: number;
  threadTaskBindings: number;
  threadContinuationEvidence: number;
  threadCollaborationEvidence: number;
  threadCollaborationCardEvidence: number;
  docReadSucceeded: number;
  agentDocReadSucceeded: number;
  docWriteSucceeded: number;
  docApprovedWritesSucceeded: number;
  sheetReadSucceeded: number;
  sheetWriteSucceeded: number;
  sheetApprovedWritesSucceeded: number;
  sheetApprovedWriteSyncSucceeded: number;
  baseReadSucceeded: number;
  baseMutateSucceeded: number;
  baseApprovedMutationsSucceeded: number;
  baseApprovedMutationSyncSucceeded: number;
  userActorEvidence: number;
  externalGuestActorEvidence: number;
  externalGuestReadSucceeded: number;
  externalGuestWriteDeniedEvidence: number;
  workerRestartRecoverySatisfied: boolean;
  workerApprovalCardActionSatisfied: boolean;
  providerFailureVisible: boolean;
  healthFailureVisible: boolean;
  agentBotFailureEvidence: number;
}): string[] {
  const issues: string[] = [];
  if (input.integration.status !== "active") {
    issues.push("integration_not_active");
  }
  if (!hasNonEmptyString(input.integration.agentId)) {
    issues.push("integration_not_agent_bot");
  }
  if (input.localEvidenceFreshness.totalRows > 0 && input.localEvidenceFreshness.freshRows === 0) {
    issues.push("stale_local_evidence_rows_ignored");
  }
  if (!input.botSatisfied) {
    if (input.processedInboundEvents === 0) {
      issues.push("processed_inbound_event_missing");
    }
    if (input.inboundMessageMappings === 0) {
      issues.push("inbound_message_mapping_missing");
    }
    if (input.sentOutboxItems === 0) {
      issues.push("sent_outbox_missing");
    }
    if (input.outboundMessageMappings === 0) {
      issues.push("outbound_message_mapping_missing");
    }
    if (input.correlatedReplyMappings === 0) {
      issues.push("correlated_reply_mapping_missing");
    }
  }
  if (!input.nativeExperienceSatisfied) {
    if (input.agentBotRouteEvidence === 0) {
      issues.push("agent_bot_route_evidence_missing");
    }
    if (input.nativeBotReplyEvidence === 0) {
      issues.push("native_agent_bot_reply_evidence_missing");
    }
    if (input.boundUserMentionEvidence === 0) {
      issues.push("bound_user_bot_mention_evidence_missing");
    }
    if (input.externalGuestMentionEvidence === 0) {
      issues.push("external_guest_bot_mention_evidence_missing");
    }
    if (input.agentChannelPolicyDeniedEvidence === 0) {
      issues.push("agent_channel_policy_disabled_evidence_missing");
    }
    if (input.botSenderLoopGuardEvidence === 0) {
      issues.push("bot_sender_loop_guard_evidence_missing");
    }
    if (input.autoProvisionedChannelBindings === 0) {
      issues.push("channel_auto_provision_evidence_missing");
    }
    if (input.botAddedAutoProvisionedChannelBindings === 0) {
      issues.push("bot_added_auto_provision_evidence_missing");
    }
    if (input.firstMessageAutoProvisionedChannelBindings === 0) {
      issues.push("first_message_auto_provision_evidence_missing");
    }
    if (input.reusedProviderChannelBindings === 0) {
      issues.push("multi_agent_channel_reuse_evidence_missing");
    }
    if (input.threadTaskBindings === 0) {
      issues.push("thread_task_binding_evidence_missing");
    }
    if (input.threadContinuationEvidence === 0) {
      issues.push("thread_continuation_evidence_missing");
    }
    if (input.threadCollaborationEvidence === 0) {
      issues.push("thread_collaboration_evidence_missing");
    } else if (input.threadCollaborationCardEvidence === 0) {
      issues.push("thread_collaboration_card_evidence_missing");
    }
  }
  if (!input.guestPolicySatisfied) {
    if (input.externalGuestAllowedEvidence === 0) {
      issues.push("external_guest_policy_allow_evidence_missing");
    }
    if (input.externalGuestReplyAllEvidence === 0) {
      issues.push("external_guest_policy_reply_all_evidence_missing");
    }
    if (input.externalGuestRequireIdentityEvidence === 0) {
      issues.push("external_guest_policy_require_identity_evidence_missing");
    }
    if (input.externalGuestIdentityBindingNoticeEvidence === 0) {
      issues.push("external_guest_identity_binding_notice_evidence_missing");
    }
    if (input.externalGuestIgnoreEvidence === 0) {
      issues.push("external_guest_policy_ignore_evidence_missing");
    }
    if (input.externalGuestMentionRequiredEvidence === 0) {
      issues.push("external_guest_policy_mention_required_evidence_missing");
    }
  }
  if (!input.dataPlaneSatisfied) {
    if (input.docReadSucceeded === 0) {
      issues.push("doc_read_evidence_missing");
    } else if (input.agentDocReadSucceeded === 0) {
      issues.push("agent_doc_read_evidence_missing");
    }
    if (input.docWriteSucceeded === 0) {
      issues.push("doc_write_evidence_missing");
    } else if (input.docApprovedWritesSucceeded === 0) {
      issues.push("doc_write_approval_evidence_missing");
    }
    if (input.sheetReadSucceeded === 0) {
      issues.push("sheet_read_evidence_missing");
    }
    if (input.sheetWriteSucceeded === 0) {
      issues.push("sheet_write_evidence_missing");
    } else if (input.sheetApprovedWritesSucceeded === 0) {
      issues.push("sheet_write_approval_evidence_missing");
    } else if (input.sheetApprovedWriteSyncSucceeded === 0) {
      issues.push("sheet_write_dofe-agent_sync_evidence_missing");
    }
    if (input.baseReadSucceeded === 0) {
      issues.push("base_read_evidence_missing");
    }
    if (input.baseMutateSucceeded === 0) {
      issues.push("base_mutate_evidence_missing");
    } else if (input.baseApprovedMutationsSucceeded === 0) {
      issues.push("base_mutate_approval_evidence_missing");
    } else if (input.baseApprovedMutationSyncSucceeded === 0) {
      issues.push("base_mutate_dofe-agent_sync_evidence_missing");
    }
    if (input.userActorEvidence === 0) {
      issues.push("user_actor_data_operation_evidence_missing");
    }
    if (input.externalGuestActorEvidence === 0) {
      issues.push("external_guest_actor_data_operation_evidence_missing");
    } else if (input.externalGuestReadSucceeded === 0) {
      issues.push("external_guest_read_evidence_missing");
    } else if (input.externalGuestWriteDeniedEvidence === 0) {
      issues.push("external_guest_write_deny_evidence_missing");
    }
  }
  if (input.integration.transportMode === "websocket_worker") {
    if (!input.botSatisfied) {
      issues.push("websocket_worker_receive_evidence_missing");
    } else if (!input.workerRestartRecoverySatisfied) {
      issues.push("websocket_worker_restart_evidence_missing");
    }
    if (!input.workerApprovalCardActionSatisfied) {
      issues.push("websocket_worker_card_action_evidence_missing");
    }
  }
  if (!input.failureSatisfied) {
    if (!input.providerFailureVisible) {
      issues.push("provider_failure_evidence_missing");
    }
    if (!input.healthFailureVisible) {
      issues.push("health_failure_evidence_missing");
    }
    if (input.providerFailureVisible && input.agentBotFailureEvidence === 0) {
      issues.push("agent_bot_failure_evidence_missing");
    }
    issues.push("failure_visibility_evidence_missing");
  }
  return issues;
}

export interface FeishuEvidenceRemediationSpec {
  stepId: string;
  title: string;
  detail: string;
  command?: string;
}

export function buildFeishuIntegrationEvidenceRemediationSteps(input: {
  workspaceId: string;
  integration: ExternalIntegrationRecord;
  issues: readonly string[];
}): FeishuEvidenceRemediationStep[] {
  const grouped = new Map<string, FeishuEvidenceRemediationStep>();
  for (const issue of input.issues) {
    const spec = mapFeishuEvidenceIssueToRemediationSpec({
      issue,
      workspaceId: input.workspaceId,
      integration: input.integration,
    });
    if (!spec) {
      continue;
    }
    const current = grouped.get(spec.stepId);
    if (current) {
      current.issues = uniqueStrings([...current.issues, issue]);
      continue;
    }
    grouped.set(spec.stepId, {
      stepId: spec.stepId,
      title: spec.title,
      detail: spec.detail,
      issues: [issue],
      ...(spec.command ? { command: spec.command } : {}),
    });
  }
  return [...grouped.values()];
}

export function mapFeishuEvidenceIssueToRemediationSpec(input: {
  issue: string;
  workspaceId: string;
  integration: ExternalIntegrationRecord;
}): FeishuEvidenceRemediationSpec | undefined {
  const dataPlaneCommands = buildFeishuDataPlaneSmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
  });
  const workerHarness = buildFeishuWorkerHarnessSummary({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
  });
  const externalGuestPolicyCommands = buildFeishuExternalGuestPolicySmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
    agentId: input.integration.agentId,
  });
  const agentChannelAccessCommands = buildFeishuAgentChannelAccessSmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
    agentId: input.integration.agentId ?? FEISHU_CLI_PLACEHOLDERS.agentName,
  });

  switch (input.issue) {
    case "integration_not_active":
      return {
        stepId: "enable_agent_bot_binding",
        title: "Live smoke: use an active Feishu agent bot binding",
        detail: "Final evidence must be captured through an active DofeAgent Feishu agent bot binding. Re-enable the intended binding or create a fresh active agent bot binding before rerunning smoke-plan, live smoke, and the final evidence gate.",
      };
    case "integration_not_agent_bot":
      return {
        stepId: "bind_feishu_agent_bot",
        title: "Live smoke: bind Feishu to a concrete DofeAgent agent",
        detail: "Final evidence cannot use a workspace-level Feishu integration as the bot identity. Bind a Feishu custom app to the concrete DofeAgent agent that users will mention in Feishu.",
        command: `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${input.integration.agentId ?? FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
      };
    case "stale_local_evidence_rows_ignored":
      return {
        stepId: "rerun_fresh_dofe-agent_live_smoke",
        title: "Live smoke: rerun stale DofeAgent evidence steps",
        detail: "The final evidence gate only counts local DofeAgent DB evidence rows from the last 24 hours. Rerun the native bot, guest-policy, data-plane, worker when using websocket_worker, and failure smoke steps, then rerun the final evidence gate.",
        command: `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId} --integration ${input.integration.id}`,
      };
    case "processed_inbound_event_missing":
    case "inbound_message_mapping_missing":
    case "sent_outbox_missing":
    case "outbound_message_mapping_missing":
    case "correlated_reply_mapping_missing":
      return {
        stepId: "live_bot_message_reply",
        title: "Live smoke: @Agent in Feishu and verify reply",
        detail: "Send a message in the bound Feishu group mentioning the concrete agent bot, then verify the final evidence sees a processed safe inbound summary, a sent Feishu agent_reply outbox with agentId, botBindingId, DofeAgent message/channel binding, safe chat/thread references, and a same-bot correlated reply mapping in the same Feishu thread.",
      };
    case "agent_bot_route_evidence_missing":
    case "bound_user_bot_mention_evidence_missing":
      return {
        stepId: "live_agent_bot_direct_mention",
        title: "Live smoke: @agent bot routes to its DofeAgent agent",
        detail: "From a bound Feishu user, mention the agent-specific Feishu bot in a group and verify DofeAgent records actorType=user, actorUserId, safe audit references, and a sent inbound mapping with agentId, botBindingId, task, and message evidence.",
      };
    case "external_guest_bot_mention_evidence_missing":
      return {
        stepId: "live_external_guest_agent_bot_mention",
        title: "Live smoke: unbound Feishu user routes as external guest",
        detail: "From an unbound Feishu user, mention the agent-specific bot and verify DofeAgent records actorType=external_guest, permissionProfile=channel_context_only, no userId/actorUserId, task/message dispatch, safe audit references, and no raw Feishu user ids.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "external_guest_policy_allow_evidence_missing":
      return {
        stepId: "live_external_guest_agent_bot_mention",
        title: "Live smoke: unbound Feishu user routes as external guest",
        detail: "From an unbound Feishu user, mention the agent-specific bot and verify DofeAgent records external_guest policy allow metadata plus low-permission task/message dispatch with permissionProfile=channel_context_only and no userId/actorUserId.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "external_guest_policy_reply_all_evidence_missing":
      return {
        stepId: "live_external_guest_reply_all",
        title: "Live smoke: external guest reply_all dispatches without mention",
        detail: `Set the agent bot external guest policy to reply_all, send an unbound Feishu message without mentioning the bot, and verify DofeAgent records the reply_all allow decision plus the low-permission task dispatch. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.replyAllCommand,
      };
    case "external_guest_policy_require_identity_evidence_missing":
      return {
        stepId: "live_external_guest_identity_required",
        title: "Live smoke: external guest is asked to bind identity",
        detail: `Set the agent bot external guest policy to require_identity, mention the bot from an unbound Feishu user, and verify DofeAgent records the require_identity decision and sends the binding notice with externalGuestReference, permissionProfile=none, and no raw Feishu open_id/union_id. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
      };
    case "external_guest_identity_binding_notice_evidence_missing":
      return {
        stepId: "live_external_guest_identity_required",
        title: "Live smoke: external guest identity notice is sent",
        detail: `Set the agent bot external guest policy to require_identity, mention the bot from an unbound Feishu user, drain the Feishu outbox, and verify DofeAgent records a sent identity-binding notice correlated to that ignored inbound message with externalGuestReference, permissionProfile=none, and no raw Feishu open_id/union_id. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
      };
    case "external_guest_policy_ignore_evidence_missing":
      return {
        stepId: "live_external_guest_reply_disabled",
        title: "Live smoke: external guest replies can be disabled",
        detail: `Set the agent bot external guest policy to ignore with permissionProfile=none, mention the bot from an unbound Feishu user, and verify DofeAgent records the ignore decision without dispatching a task or reply. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.ignoreCommand,
      };
    case "external_guest_policy_mention_required_evidence_missing":
      return {
        stepId: "live_unmentioned_guest_message_ignored",
        title: "Live smoke: unmentioned guest message is ignored",
        detail: "With reply_on_mention enabled, send an unbound Feishu message that does not mention the agent bot and verify DofeAgent records the bot-mention-required decision without dispatching.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "agent_channel_policy_disabled_evidence_missing":
      return {
        stepId: "live_agent_channel_policy_disabled",
        title: "Live smoke: disabled agent/channel policy blocks replies",
        detail: `Disable the agent's channel-member access, mention the Feishu agent bot, and verify DofeAgent records the policy denial without writing a channel message, queueing a task, or sending a bot reply. Restore after this smoke step with: ${agentChannelAccessCommands.restoreCommand}`,
        command: agentChannelAccessCommands.disableCommand,
      };
    case "channel_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_channel_auto_provision",
        title: "Live smoke: agent bot auto-provisions channel",
        detail: "Add the agent bot to a new Feishu group or send a first mentioned message in an unbound group, then verify the channel binding records an DofeAgent channel name, review status, and safe chat reference with bot_added or first_message auto-provisioning.",
      };
    case "bot_added_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_channel_auto_provision",
        title: "Live smoke: agent bot auto-provisions channel",
        detail: "Add the agent bot to a new Feishu group and verify the channel binding records provisionSource=bot_added with DofeAgent channel identity, review status, and safe chat reference metadata.",
      };
    case "first_message_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_first_message_auto_provision",
        title: "Live smoke: first mentioned message provisions channel",
        detail: "Send the first mentioned message from an unbound Feishu group and verify DofeAgent records provisionSource=first_message with DofeAgent channel identity, review status, and safe chat reference metadata.",
      };
    case "multi_agent_channel_reuse_evidence_missing":
      return {
        stepId: "live_multi_agent_bot_channel_reuse",
        title: "Live smoke: second agent bot reuses channel",
        detail: "Add a second agent bot to the same Feishu group and verify DofeAgent adds that agent to the existing channel with a distinct linkedFromBindingId plus different linkedFromAgentId/linkedFromBotBindingId metadata instead of creating a duplicate channel.",
      };
    case "thread_task_binding_evidence_missing":
      return {
        stepId: "live_feishu_thread_task_binding",
        title: "Live smoke: Feishu thread binds to DofeAgent task",
        detail: "Mention the agent bot in a Feishu thread and verify DofeAgent records the thread binding with taskQueueId, dofeAgentMessageId, agentId, and botBindingId.",
      };
    case "thread_continuation_evidence_missing":
      return {
        stepId: "live_feishu_thread_continuation",
        title: "Live smoke: Feishu thread follow-up continues without re-mention",
        detail: "After a mentioned agent bot message creates a Feishu thread binding, send a follow-up in the same Feishu thread without mentioning the bot and verify DofeAgent records threadContinuation=true with taskQueueId, dofeAgentMessageId, agentId, botBindingId, and the same active thread binding reference.",
      };
    case "thread_collaboration_evidence_missing":
    case "thread_collaboration_card_evidence_missing":
      return {
        stepId: "live_multi_agent_thread_collaboration",
        title: "Live smoke: second agent bot joins an active thread",
        detail: "Mention one agent bot in a Feishu thread, then mention a second agent bot in that same thread and verify DofeAgent keeps separate thread bindings, records threadCollaboration=true with collaborator agent ids and bot binding ids, and sends a collaboration card that matches the active thread binding without raw Feishu ids.",
      };
    case "bot_sender_loop_guard_evidence_missing":
      return {
        stepId: "live_multi_agent_thread_collaboration",
        title: "Live smoke: second agent bot joins an active thread",
        detail: "Mention one agent bot in a Feishu thread, then have another registered agent bot reply or mention it in the same group; verify DofeAgent records feishu_bot_sender_ignored without dispatching a task or leaking raw Feishu ids.",
      };
    case "doc_read_evidence_missing":
      return {
        stepId: "live_doc_read",
        title: "Live smoke: read bound Feishu Doc",
        detail: "Run the DofeAgent data-operation Doc read smoke so a succeeded, non-runtime Doc read operation is recorded with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens.",
        command: dataPlaneCommands.liveDocReadCommand,
      };
    case "agent_doc_read_evidence_missing":
      return {
        stepId: "live_agent_bound_doc_summary",
        title: "Live smoke: @Agent summarizes a bound Feishu Doc",
        detail: "Ask an Agent from the bound Feishu group to summarize the already-bound Doc so DofeAgent records the lark-cli result-manifest Doc read evidence.",
      };
    case "doc_write_evidence_missing":
    case "doc_write_approval_evidence_missing":
      return {
        stepId: "live_doc_write_with_approval",
        title: "Live smoke: approve a small Doc write",
        detail: "Create and approve the governed Doc append operation so the operation run carries approvalId, SHA-256 payloadHash, approved policy metadata, active resource binding, and a safe Feishu write result.",
        command: dataPlaneCommands.liveDocWriteCommand,
      };
    case "sheet_read_evidence_missing":
      return {
        stepId: "live_sheet_read",
        title: "Live smoke: read bound Feishu Sheet",
        detail: "Run the DofeAgent data-operation Sheet read smoke so a succeeded safe range preview is recorded with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens.",
        command: dataPlaneCommands.liveSheetReadCommand,
      };
    case "sheet_write_evidence_missing":
    case "sheet_write_approval_evidence_missing":
    case "sheet_write_dofe-agent_sync_evidence_missing":
      return {
        stepId: "live_sheet_write_with_approval",
        title: "Live smoke: approve a small Sheet write",
        detail: "Create and approve the governed Sheet write smoke so the operation run carries approvalId, SHA-256 payloadHash, approved policy metadata, active resource binding, and DofeAgent syncs the bound data table preview from the approved write result.",
        command: dataPlaneCommands.liveSheetWriteCommand,
      };
    case "base_read_evidence_missing":
    case "base_mutate_evidence_missing":
    case "base_mutate_approval_evidence_missing":
    case "base_mutate_dofe-agent_sync_evidence_missing":
      return {
        stepId: "live_base_preview_and_update",
        title: "Live smoke: preview and update one Base record",
        detail: "Run the Base preview plus approved Base update smoke so DofeAgent records safe read evidence with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens, plus approvalId, SHA-256 payloadHash, Feishu Base write evidence, and approved data-table sync evidence.",
        command: dataPlaneCommands.liveBaseCommand,
      };
    case "user_actor_data_operation_evidence_missing":
      return {
        stepId: "live_bound_user_data_operation",
        title: "Live smoke: bound Feishu user data operation",
        detail: "Bind one Feishu user to an DofeAgent user, then ask that user to trigger a governed Doc/Sheet/Base operation so the run records governanceContext.actorType=user.",
        command: dataPlaneCommands.liveDocReadCommand,
      };
    case "external_guest_actor_data_operation_evidence_missing":
    case "external_guest_read_evidence_missing":
      return {
        stepId: "live_external_guest_read_guest_readable",
        title: "Live smoke: external guest reads guest-readable resource",
        detail: "From an unbound Feishu user, ask an agent bot to read a guest-readable resource bound to the current channel and verify DofeAgent records permissionProfile=channel_context_only plus externalGuestResourceAccess=guest_readable_current_channel.",
        command: [
          externalGuestPolicyCommands.replyOnMentionCommand,
          dataPlaneCommands.liveDocReadCommand,
        ].join("\n"),
      };
    case "external_guest_write_deny_evidence_missing":
      return {
        stepId: "live_external_guest_write_denied",
        title: "Live smoke: external guest write is denied",
        detail: `From an unbound Feishu user, ask an agent bot to write a bound Sheet/Base resource and verify DofeAgent records external_guest governance with permissionProfile=none or permissionProfile=channel_context_only on the bound write operation plus the identity-required denial. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: [
          externalGuestPolicyCommands.requireIdentityCommand,
          dataPlaneCommands.liveSheetWriteCommand,
        ].join("\n"),
      };
    case "websocket_worker_receive_evidence_missing":
      return {
        stepId: "live_websocket_receive_message",
        title: "Live smoke: receive Feishu message through WebSocket worker",
        detail: "Start the self-hosted WebSocket worker, send a bound Feishu message, and verify the DofeAgent task/reply path runs without the HTTP callback route.",
        command: workerHarness.startCommand,
      };
    case "websocket_worker_restart_evidence_missing":
      return {
        stepId: "live_websocket_worker_restart",
        title: "Live smoke: restart WebSocket worker and verify recovery",
        detail: "Restart the WebSocket worker and send another bound Feishu message so the final evidence gate sees two correlated WebSocket replies.",
        command: workerHarness.systemdRestartCommand,
      };
    case "websocket_worker_card_action_evidence_missing":
      return {
        stepId: "live_websocket_receive_message",
        title: "Live smoke: receive Feishu message through WebSocket worker",
        detail: "Trigger one approval card action through the self-hosted worker so DofeAgent proves card-button governance without a public callback URL.",
        command: workerHarness.startCommand,
      };
    case "provider_failure_evidence_missing":
    case "health_failure_evidence_missing":
    case "agent_bot_failure_evidence_missing":
    case "failure_visibility_evidence_missing":
      return {
        stepId: "live_failure_visibility",
        title: "Live smoke: verify visible provider failure",
        detail: "Temporarily use a wrong agent bot secret, revoke a required scope, or force a failed agent-bot outbox/data operation, then refresh Feishu health until degraded/error status and a provider failure row with agentId, botBindingId, and safe chat/resource context are both visible.",
        command: `dofe-agent integrations feishu health-check --workspace-id ${input.workspaceId} --integration ${input.integration.id} --json`,
      };
    default:
      return undefined;
  }
}
