import { type OutputFormat } from "../../lib/format.ts";
import { runFeishuIntegrationCommand } from "./feishu.ts";
import { runIntegrationsOutboxCommand } from "./outbox.ts";

export async function runIntegrationsCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): Promise<number> {
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printIntegrationsHelp();
    return subcommand ? 0 : 1;
  }

  if (subcommand === "outbox") {
    return runIntegrationsOutboxCommand(args, format);
  }

  if (subcommand === "feishu") {
    return runFeishuIntegrationCommand(args, format);
  }

  printIntegrationsHelp();
  return 1;
}

function printIntegrationsHelp(): void {
  console.log(`Usage:
  dofe-agent integrations outbox drain [--workspace-id <id>] [--integration <id>] [--limit <n>] [--base-url <url>] [--locked-by <id>] [--json]
  dofe-agent integrations feishu create --workspace-id <id> [--env-file scripts/feishu/.env] --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --verification-token-env FEISHU_VERIFICATION_TOKEN [--encrypt-key-env FEISHU_ENCRYPT_KEY] [--json]
  dofe-agent integrations feishu bind-agent-bot --workspace-id <id> --agent <agent-id-or-name> [--env-file scripts/feishu/.env] --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET [--json]
  dofe-agent integrations feishu rotate-agent-bot-secret --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) --app-secret-env FEISHU_APP_SECRET [--json]
  dofe-agent integrations feishu disable-agent-bot --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) [--json]
  dofe-agent integrations feishu auto-provision-policy --workspace-id <id> (--agent <agent-id-or-name>|--integration <id>) [--bot-added-policy auto_create_channel|pending_admin_review|disabled] [--unbound-user-mode ignore|reply_on_mention|reply_all|require_identity] [--json]
  dofe-agent integrations feishu agent-channel-access --workspace-id <id> (--agent <agent-id-or-name>|--integration <agent-bot-id>) --access enabled|disabled [--json]
  dofe-agent integrations feishu agent-bot-readiness --workspace-id <id> [--agent <agent-id-or-name>|--integration <id>] [--strict] [--json]
  dofe-agent integrations feishu worker [--workspace-id <id>] [--integration <id>] [--limit <n>] [--base-url <url>] [--domain <host>] [--locked-by <id>] [--dry-run] [--include-webhook] [--drain-outbox|--once] [--json]
  dofe-agent integrations feishu readiness [--workspace-id <id>] [--integration <id>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-plan [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-env [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--json]
  dofe-agent integrations feishu health-check [--workspace-id <id>] [--integration <id>|--agent <agent-id-or-name>] [--base-url <url>] [--dry-run] [--strict] [--json]
  dofe-agent integrations feishu evidence [--workspace-id <id>] [--integration <id>] [--openapi-evidence <path>] [--bot-added-payload-evidence <path>] [--strict] [--require bot|native|guest-policy|data-plane|worker|failure|all] [--json]
  dofe-agent integrations feishu data-operation --workspace-id <id> --integration <id> --operation read-doc|plan-doc-create|plan-doc-update|plan-doc-append|read-sheet|query-base|plan-sheet-write|plan-base-update --resource <url-or-token> [--range <sheet-range>] [--parent-block-id <block-id>] [--approval-agent <agent-id> --approval-channel <channel>] [--json]
  dofe-agent integrations feishu review-data-operation --workspace-id <id> --approval-id <approval-id> --decision approved|rejected [--json]
  dofe-agent integrations feishu channel-bindings --workspace-id <id> [--integration <id>] [--status active|disabled|archived] [--json]
  dofe-agent integrations feishu bind-channel --workspace-id <id> --integration <id> --channel <name> --chat-id <oc_xxx> [--json]
  dofe-agent integrations feishu bind-user --workspace-id <id> --integration <id> --user-id <dofe-agent-user-id> --open-id <ou_xxx> [--json]
  dofe-agent integrations feishu bind-resource --workspace-id <id> --integration <id> --type doc|sheet|base|base_table|base_view --resource <url-or-token> --dofe-agent-type channel_document|data_table|knowledge_page [--allow-write] [--guest-readable] [--json]

Feishu evidence artifacts:
  --openapi-evidence and --bot-added-payload-evidence are required for --require all.

Examples:
  dofe-agent integrations feishu create --workspace-id default --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --verification-token-env FEISHU_VERIFICATION_TOKEN --encrypt-key-env FEISHU_ENCRYPT_KEY --json
  dofe-agent integrations feishu bind-agent-bot --workspace-id default --agent Codex --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json
  dofe-agent integrations feishu auto-provision-policy --workspace-id default --agent Codex --unbound-user-mode reply_on_mention --guest-permission-profile channel_context_only --json
  dofe-agent integrations feishu agent-channel-access --workspace-id default --agent Codex --access disabled --json
  dofe-agent integrations feishu agent-bot-readiness --workspace-id default --agent Codex --strict --json
  dofe-agent integrations feishu worker --dry-run --include-webhook --json
  dofe-agent integrations feishu worker --workspace-id default --integration feishu-1 --once --json
  dofe-agent integrations feishu readiness --workspace-id default --strict --require data-plane --json
  dofe-agent integrations feishu smoke-plan --workspace-id default --app-url https://dofe-agent.example.com
  dofe-agent integrations feishu smoke-env --workspace-id default --integration feishu-1 --app-url https://dofe-agent.example.com
  dofe-agent integrations feishu health-check --workspace-id default --agent Codex --json
  dofe-agent integrations feishu evidence --workspace-id default --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all
  dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation plan-doc-append --resource CHANGE_ME_FEISHU_DOC_URL_OR_TOKEN --parent-block-id CHANGE_ME_DOC_BLOCK_ID --blocks-json '[{"block_type":2,"text":{"elements":[]}}]' --approval-agent Atlas --approval-channel general --json
  dofe-agent integrations feishu review-data-operation --workspace-id default --approval-id CHANGE_ME_FEISHU_APPROVAL_ID --decision approved --json
  dofe-agent integrations feishu channel-bindings --workspace-id default --json
  dofe-agent integrations feishu data-operation --workspace-id default --integration feishu-1 --operation read-sheet --resource CHANGE_ME_FEISHU_SHEET_URL_OR_TOKEN --range Sheet1!A1:C5 --json
  dofe-agent integrations feishu bind-channel --workspace-id default --integration feishu-1 --channel CHANGE_ME_DOFE_AGENT_CHANNEL --chat-id CHANGE_ME_FEISHU_CHAT_ID --json`);
}
