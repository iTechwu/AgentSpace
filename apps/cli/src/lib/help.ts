export function printRootHelp(): void {
  console.log(`dofe-agent — local control CLI for DofeAgent

Usage:
  dofe-agent <command> [subcommand] [options]

Commands:
  doctor                    Check local project readiness
  db status                 Show database status
  db storage-scan           Scan orphan workspace and daemon storage artifacts
  db workspace-purge        Hard-delete a workspace and its storage roots
  daemon start              Start the native daemon
  daemon stop               Stop the native daemon
  daemon status             Show native daemon status
  daemon logs               Show daemon logs
  daemon token              Manage remote daemon API tokens
  dev web [--port <n>]      Start the web app
  workspace status          Show current workspace summary
  workspace context         Query workspace context from the current agent runtime
  workspace init            Initialize workspace; use --reset to clear current state
  im channels               List IM channels
  im feed                   Show recent collaboration feed
  integrations outbox       Drain external integration outbox
  integrations feishu       Start/dry-run Feishu worker and inspect readiness/smoke plan
  channel list              List channels
  channel create            Create a new channel
  employee list             List active digital employees
  employee create           Create an active employee
  material list             List imported source materials
  material add              Add a new source material
  material import-file      Import a real file into local workspace state
  material parse            Parse an imported file into preview text
  skill list                List workspace skills
  skill import              Import a skill from a supported external URL
  skill export              Export one or more skills as a zip bundle
  output attach             Add a runtime-output attachment manifest entry
  output sheets-result      Register an Agent-executed Google Sheet result
  output google-docs        Register Google Docs operations
  output validate           Validate runtime-output manifests
  output preview            Preview runtime-output manifests
  message list              List recent collaboration messages
  message post              Post a new collaboration message
  task list                 List current tasks
  task create               Create a task
  task move                 Change task status
  cost summary              Show workspace cost summary
  cost agent                Show cost for a specific agent
  cost recent               Show recent token usage records
  cost pricing              List model pricing table
  cost budget list          List budget settings
  cost budget set           Create or update a budget
  cost budget check         Check budget status for an agent
  help                      Show this help

Output:
  --json
  --format json|text

Examples:
  dofe-agent doctor
  dofe-agent db status
  dofe-agent daemon start
  dofe-agent daemon token create --label build-box-1
  dofe-agent workspace status
  dofe-agent workspace context list-entities --json
  dofe-agent im channels --json
  dofe-agent integrations outbox drain --workspace-id default --limit 10 --json
  dofe-agent integrations feishu worker --dry-run --include-webhook --json
  dofe-agent integrations feishu readiness --workspace-id default --strict --require data-plane --json
  dofe-agent integrations feishu health-check --workspace-id default --json
  dofe-agent integrations feishu evidence --workspace-id default --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all
  dofe-agent integrations feishu smoke-plan --workspace-id default --app-url https://dofe-agent.example.com
  dofe-agent integrations feishu smoke-env --workspace-id default --integration feishu-1 --app-url https://dofe-agent.example.com
  dofe-agent employee create --name Vega --role "发布协调员" --traits 发布窗口,跨组协调
  dofe-agent employee create --name Nova --role "值守协调员" --channel general
  dofe-agent material add --source "客户录音" --status "待转写"
  dofe-agent material import-file --path ./Target.md --label "产品目标文档"
  dofe-agent material parse --id mat-123
  dofe-agent skill list --json
  dofe-agent skill import --url https://github.com/octo-org/skill-repo/tree/main/skills/research-pack --conflict rename --json
  dofe-agent skill export skill-abc123 --out ./research-pack.zip --json
  dofe-agent output attach runtime-output/artifacts/chart.png --name chart.png --media-type image/png --text "图表已生成。"
  dofe-agent output sheets-result add --document-id channel-doc-123 --operation read --range Sheet1!A1:Z20 --result-json runtime-output/artifacts/sheets/read-1.json --summary "Read 20 rows."
  dofe-agent output google-docs append-text --document-id channel-doc-456 --intent "Append meeting notes" --text-file runtime-output/artifacts/docs/summary.md
  dofe-agent output validate --json
  dofe-agent message post --channel general --summary "先确认今天的优先级"
  dofe-agent task create --title "整理联调顺序" --channel general --assignee Nova --priority high
  dofe-agent dev web --port 1455`);
}

export function printCommandHelp(command: string): void {
  if (command === "dev") {
    console.log(`Usage:
  dofe-agent dev web [--port <n>] [--hostname <host>]`);
    return;
  }

  if (command === "db") {
    console.log(`Usage:
  dofe-agent db status [--json]
  dofe-agent db storage-scan [--json]
  dofe-agent db workspace-purge --id <workspace-id> --force [--json]`);
    return;
  }

  if (command === "daemon") {
    console.log(`Usage:
  dofe-agent daemon start [--foreground] [--mode local|remote] [--daemon-id <id>] [--device-name <name>] [--runtime-name <label>] [--heartbeat-interval <ms>] [--server-url <url>] [--daemon-token <token>]
  dofe-agent daemon stop
  dofe-agent daemon status [--json]
  dofe-agent daemon logs [--lines <n>] [--follow]
  dofe-agent daemon token create --label <label> [--created-by <name>] [--json]
  dofe-agent daemon token list [--json]
  dofe-agent daemon token revoke --id <token-id> [--json]`);
    return;
  }

  if (command === "workspace") {
    console.log(`Usage:
  dofe-agent workspace status [--json]
  dofe-agent workspace context list-entities [--json]
  dofe-agent workspace context resolve-entity --query <text> [--json]
  dofe-agent workspace context list-channels [--json]
  dofe-agent workspace context search-messages --query <text> [--channel <name>] [--json]
  dofe-agent workspace context list-documents [--channel <name>] [--json]
  dofe-agent workspace init --reset [--json]
  dofe-agent workspace init --name <organization> --owner <name> --owner-role <role> [--json]`);
    return;
  }

  if (command === "im") {
    console.log(`Usage:
  dofe-agent im channels [--json]
  dofe-agent im feed [--json]`);
    return;
  }

  if (command === "integrations") {
    console.log(`Usage:
  dofe-agent integrations outbox drain [--workspace-id <id>] [--integration <id>] [--limit <n>] [--base-url <url>] [--locked-by <id>] [--json]
  dofe-agent integrations feishu worker [--workspace-id <id>] [--integration <id>] [--limit <n>] [--base-url <url>] [--domain <host>] [--locked-by <id>] [--dry-run] [--include-webhook] [--drain-outbox|--once] [--json]
  dofe-agent integrations feishu readiness [--workspace-id <id>] [--integration <id>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-plan [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--strict] [--require bot|data-plane|worker] [--json]
  dofe-agent integrations feishu smoke-env [--workspace-id <id>] [--integration <id>] [--app-url <url>] [--json]
  dofe-agent integrations feishu health-check [--workspace-id <id>] [--integration <id>] [--base-url <url>] [--dry-run] [--strict] [--json]
  dofe-agent integrations feishu evidence [--workspace-id <id>] [--integration <id>] [--openapi-evidence <path>] [--bot-added-payload-evidence <path>] [--strict] [--require bot|native|guest-policy|data-plane|worker|failure|all] [--json]
  dofe-agent integrations feishu data-operation --workspace-id <id> --integration <id> --operation read-doc|read-sheet|query-base|plan-sheet-write|plan-base-update --resource <url-or-token> [--range <sheet-range>] [--json]
  dofe-agent integrations feishu agent-channel-access --workspace-id <id> (--agent <agent-id-or-name>|--integration <agent-bot-id>) --access enabled|disabled [--json]
  dofe-agent integrations feishu bind-channel --workspace-id <id> --integration <id> --channel <name> --chat-id <oc_xxx> [--json]
  dofe-agent integrations feishu bind-user --workspace-id <id> --integration <id> --user-id <dofe-agent-user-id> --open-id <ou_xxx> [--json]
  dofe-agent integrations feishu bind-resource --workspace-id <id> --integration <id> --type doc|sheet|base|base_table|base_view --resource <url-or-token> --dofe-agent-type channel_document|data_table|knowledge_page [--allow-write] [--json]

Examples:
  dofe-agent integrations feishu worker --dry-run --include-webhook --json
  dofe-agent integrations feishu worker --workspace-id default --integration feishu-1 --once --json
  dofe-agent integrations feishu readiness --workspace-id default --strict --require data-plane --json
  dofe-agent integrations feishu smoke-plan --workspace-id default --app-url https://dofe-agent.example.com
  dofe-agent integrations feishu smoke-env --workspace-id default --integration feishu-1 --app-url https://dofe-agent.example.com
  dofe-agent integrations feishu health-check --workspace-id default --json
  dofe-agent integrations feishu agent-channel-access --workspace-id default --agent Codex --access disabled --json
  dofe-agent integrations feishu evidence --workspace-id default --openapi-evidence runtime-output/feishu-smoke/live.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --strict --require all
  dofe-agent integrations feishu bind-channel --workspace-id default --integration feishu-1 --channel general --chat-id oc_xxx --json`);
    return;
  }

  if (command === "channel") {
    console.log(`Usage:
  dofe-agent channel list [--json]
  dofe-agent channel create --name <name> [--json]
  dofe-agent channel delete --name <name> [--json]
  dofe-agent channel rename --name <name> --to <next-name> [--json]`);
    return;
  }

  if (command === "employee") {
    console.log(`Usage:
  dofe-agent employee list [--json]
  dofe-agent employee create --name <name> --role <role> [--traits a,b] [--summary <text>] [--fit <text>] [--origin <label>] [--json]
  dofe-agent employee bind-runtime --name <employee> --runtime-id <runtime-id> [--json]
  dofe-agent employee unbind-runtime --name <employee> [--json]`);
    return;
  }

  if (command === "material") {
    console.log(`Usage:
  dofe-agent material list [--json]
  dofe-agent material add --source <source> [--status <status>] [--json]
  dofe-agent material import-file --path <file-path> [--label <name>] [--status <status>] [--json]
  dofe-agent material parse --id <material-id> [--json]`);
    return;
  }

  if (command === "skill") {
    console.log(`Usage:
  dofe-agent skill list [--workspace-id <id>] [--json]
  dofe-agent skill get <skill-id> [--workspace-id <id>] [--json]
  dofe-agent skill create --name <name> [--description <text>] [--workspace-id <id>] [--json]
  dofe-agent skill update <skill-id> [--name <name>] [--description <text>] [--workspace-id <id>] [--json]
  dofe-agent skill delete <skill-id> [--workspace-id <id>] [--json]
  dofe-agent skill files list <skill-id> [--workspace-id <id>] [--json]
  dofe-agent skill files upsert <skill-id> --path <path> --content <content> [--file-id <id>] [--workspace-id <id>] [--json]
  dofe-agent skill files delete <skill-id> --file-id <id> [--workspace-id <id>] [--json]
  dofe-agent skill import --url <url> [--conflict reject|rename|replace|skip] [--workspace-id <id>] [--json]
  dofe-agent skill export <skill-id> [more-skill-ids...] [--workspace-id <id>] [--out <zip-path>] [--json]`);
    return;
  }

  if (command === "output") {
    console.log(`Usage:
  dofe-agent output attach <file> [--name <display-name>] [--media-type <mime>] [--text <message>] [--copy] [--work-dir <path>] [--json]
  dofe-agent output text <message> [--work-dir <path>] [--json]
  dofe-agent output document upsert --title <title> --content <path> [--document-id <id>] [--base-version-id <id>] [--summary <text>] [--mode create|update|create_or_update] [--json]
  dofe-agent output document replace-block --document-id <id> --base-version-id <id> --title <title> --block-id <id> --base-revision <n> --content <path> [--heading <text>] [--json]
  dofe-agent output document insert-after --document-id <id> --base-version-id <id> --title <title> [--after-block-id <id>] --content <path> [--heading <text>] [--json]
  dofe-agent output document delete-block --document-id <id> --base-version-id <id> --title <title> --block-id <id> --base-revision <n> [--json]
  dofe-agent output skill import --url <url> [--conflict reject|rename|replace|skip] [--assign-to-self true|false] [--json]
  dofe-agent output skill import --path runtime-output/artifacts/skills/name [--conflict reject|rename|replace|skip] [--json]
  dofe-agent output skill import --local-path <path> [--conflict reject|rename|replace|skip] [--json]
  dofe-agent output knowledge propose-create --title <title> --content-file runtime-output/artifacts/knowledge/page.md [--assignment-mode all_agents|selected_agents] [--reason <text>] [--json]
  dofe-agent output knowledge propose-update --knowledge-page-id <page-id> --base-updated-at <iso> --title <title> --content-file runtime-output/artifacts/knowledge/page.md [--reason <text>] [--json]
  dofe-agent output sheets read --document-id <id> --range <A1> --intent <text> [--json]
  dofe-agent output sheets append-rows --document-id <id> --range <A1> --intent <text> --values-json <json> [--json]
  dofe-agent output sheets update-values --document-id <id> --range <A1> --intent <text> --values-json <json> [--json]
  dofe-agent output sheets batch-update --document-id <id> --intent <text> --requests-json <json> [--json]
  dofe-agent output sheets-result add --document-id <id> --operation read|append_rows|update_values|batch_update --result-json runtime-output/artifacts/sheets/result.json [--range <A1>] [--summary <text>] [--request-summary <text>] [--json]
  dofe-agent output google-docs append-text --document-id <doc-id> --intent <text> --text-file runtime-output/artifacts/docs/summary.md [--request-summary <text>] [--json]
  dofe-agent output google-docs batch-update --document-id <doc-id> --intent <text> --requests-json runtime-output/artifacts/docs/requests.json [--request-summary <text>] [--json]
  dofe-agent output feishu data-operation-approval --operation docs.update_document|sheets.update_range|base.mutate_records --type doc|sheet|base_table --resource <bound-feishu-token> [--parameters-json <json>] [--preview <text>] [--json]
  dofe-agent output validate [--work-dir <path>] [--json]
  dofe-agent output preview [--work-dir <path>] [--json]`);
    return;
  }

  if (command === "message") {
    console.log(`Usage:
  dofe-agent message list [--json]
  dofe-agent message post --channel <name> --summary <text> [--speaker <name>] [--role human|agent] [--json]`);
    return;
  }

  if (command === "task") {
    console.log(`Usage:
  dofe-agent task list [--json]
  dofe-agent task create --title <title> --channel <name> --assignee <employee> [--priority low|medium|high] [--json]
  dofe-agent task move --id <task-id> --status todo|in_progress|blocked|done [--json]
  dofe-agent task inspect --id <task-id> [--json]`);
    return;
  }

  if (command === "cost") {
    console.log(`Usage:
  dofe-agent cost summary [--workspace-id <id>] [--period monthly|total] [--json]
  dofe-agent cost agent --name <agent> [--workspace-id <id>] [--period monthly|total] [--json]
  dofe-agent cost recent [--workspace-id <id>] [--agent <name>] [--limit <n>] [--json]
  dofe-agent cost pricing [--json]
  dofe-agent cost budget list [--workspace-id <id>] [--json]
  dofe-agent cost budget set --scope <workspace|agent|channel> [--scope-id <id>] --workspace-id <id> --limit <usd> [--period monthly|total] [--action warn|pause|approve] [--threshold <0-1>] [--json]
  dofe-agent cost budget toggle --id <budget-id> [--workspace-id <id>] --enabled true|false [--json]
  dofe-agent cost budget delete --id <budget-id> [--workspace-id <id>] [--json]
  dofe-agent cost budget check --agent <name> [--workspace-id <id>] [--channel <name>] [--json]`);
    return;
  }

  printRootHelp();
}
