import type { IntegrationProviderDescriptor } from "../../core/index.ts";
export declare const FEISHU_PROVIDER_ID = "feishu";
export declare const FEISHU_EVENT_CALLBACK_PATH = "/api/integrations/feishu/events";
export declare const FEISHU_BOT_SMOKE_SCOPES: readonly ["im:message", "im:message:send_as_bot", "contact:user.base:readonly"];
export declare const FEISHU_DATA_PLANE_SMOKE_SCOPES: readonly ["docx:document", "drive:drive", "sheets:spreadsheet", "bitable:app"];
export declare const FEISHU_DEFAULT_SCOPES: readonly ["im:message", "im:message:send_as_bot", "contact:user.base:readonly", "docx:document", "drive:drive", "sheets:spreadsheet", "bitable:app"];
export declare const FEISHU_REQUIRED_EVENTS: readonly ["im.message.receive_v1", "im.chat.member.bot.added_v1", "card.action.trigger"];
export declare const FEISHU_AGENT_BOT_REQUIRED_CREDENTIAL_FIELDS: readonly ["app_id", "app_secret"];
export declare const FEISHU_EVENT_CALLBACK_REQUIRED_CREDENTIAL_FIELDS: readonly ["app_id", "app_secret", "verification_token"];
export declare const FEISHU_RECOMMENDED_CREDENTIAL_FIELDS: readonly ["encrypt_key"];
export declare const FEISHU_REQUIRED_CREDENTIAL_FIELDS: readonly ["app_id", "app_secret", "verification_token"];
export declare const FEISHU_OPEN_PLATFORM_CONSOLE_URLS: {
    readonly appList: "https://open.feishu.cn/app";
};
export declare const FEISHU_OPEN_PLATFORM_SETUP_STEPS: readonly [{
    readonly id: "create_custom_app";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["app_id", "app_secret"];
}, {
    readonly id: "enable_bot";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["bot_enabled"];
}, {
    readonly id: "configure_event_subscription";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["event_callback_url", "im.message.receive_v1", "im.chat.member.bot.added_v1", "card.action.trigger"];
}, {
    readonly id: "grant_bot_scopes";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["im:message", "im:message:send_as_bot", "contact:user.base:readonly"];
}, {
    readonly id: "grant_data_plane_scopes";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["docx:document", "drive:drive", "sheets:spreadsheet", "bitable:app"];
}, {
    readonly id: "release_or_install_app";
    readonly consoleUrl: "https://open.feishu.cn/app";
    readonly required: readonly ["tenant_install_or_publish"];
}];
export declare const FEISHU_FINAL_EVIDENCE_GATE_REQUIREMENTS: {
    readonly botReply: "processed_inbound_with_safe_summary + sent_agent_bot_reply_outbox_with_safe_context + same_agent_bot_correlated_reply_mapping";
    readonly nativeAgentBot: "direct_agent_bot_route_with_safe_context + bound_user_bot_mention_with_safe_context + external_guest_bot_mention_with_safe_context + bot_added_auto_provision_with_channel_identity_review_state + first_message_auto_provision_with_channel_identity_review_state + multi_agent_channel_reuse_distinct_binding + thread_task_binding + thread_continuation_without_remention_active_binding + thread_collaboration_distinct_bot_binding + sent_thread_collaboration_card + bot_sender_loop_guard_without_reply + agent_channel_policy_denial_without_reply";
    readonly guestPolicy: "external_guest_reply_on_mention_allow_with_dispatch + external_guest_reply_all_without_mention + external_guest_require_identity_without_dispatch + sent_identity_binding_notice + external_guest_ignore_without_dispatch_or_reply + external_guest_mention_required_without_dispatch_or_reply";
    readonly workerRestart: "two_correlated_websocket_replies";
    readonly workerCardAction: "processed_approval_card_action_with_governance_context";
    readonly dataPlane: "bound_governed_doc_read + agent_runtime_doc_read_from_lark_cli_manifest + bound_approved_doc_write + bound_governed_sheet_read + bound_approved_sheet_write_with_agentspace_sync + bound_governed_base_read + bound_approved_base_mutation_with_agentspace_sync + user_actor + external_guest_actor + external_guest_read_guest_readable_current_channel + external_guest_bound_write_denied";
    readonly failureVisibility: "provider_failure_row + degraded_or_error_health + agent_bot_failure_with_safe_context";
};
export declare const FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS: readonly ["Client im.message.create", "AgentSpace callback URL verification", "Tenant access token", "Docs docx metadata", "Docs docx read blocks", "Docs docx append blocks", "Sheets metadata", "Sheets read values", "Sheets write values", "Base list tables", "Base list records", "Base update record"];
export declare const FEISHU_OPENAPI_REQUIRED_REQUEST_STEPS: readonly ["Client im.message.create", "Docs docx metadata", "Docs docx read blocks", "Docs docx append blocks", "Sheets metadata", "Sheets read values", "Sheets write values", "Base list tables", "Base list records", "Base update record"];
export declare const FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS: readonly ["Docs docx append blocks", "Sheets write values", "Base update record"];
export declare const FEISHU_PROVIDER_DESCRIPTOR: IntegrationProviderDescriptor;
