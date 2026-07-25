import {
  initializeOrganizationSync,
  listWorkspaceContextChannelsSync,
  listWorkspaceContextDocumentsSync,
  listWorkspaceContextEntitiesSync,
  resolveWorkspaceContextEntitySync,
  readWorkspaceSummarySync,
  resetWorkspaceStateSync,
  searchWorkspaceContextMessagesSync,
} from "@dofe-agent/services";
import { readQueuedTaskSync } from "@dofe-agent/db";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

const WORKSPACE_CONTEXT_AGENT_ENV = "DOFE_AGENT_CONTEXT_AGENT_NAME";
const WORKSPACE_CONTEXT_TASK_ENV = "DOFE_AGENT_CONTEXT_TASK_ID";

export function runWorkspaceCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "context") {
    return runWorkspaceContextCommand(args, format);
  }

  if (subcommand === "status") {
    writeData(format, readWorkspaceSummarySync());
    return 0;
  }

  if (subcommand === "init") {
    const { flags } = parseArgs(args);
    const organizationName = getStringFlag(flags, "name");
    const ownerName = getStringFlag(flags, "owner");
    const ownerRole = getStringFlag(flags, "owner-role");
    const shouldReset = flags.reset === true;

    if (!shouldReset && !organizationName && !ownerName && !ownerRole) {
      console.error(
        "Usage: dofe-agent workspace init --reset [--json]\n       dofe-agent workspace init --name <organization> --owner <name> --owner-role <role> [--json]",
      );
      console.error("Refusing to reset the workspace without an explicit --reset flag.");
      return 1;
    }

    const state =
      organizationName || ownerName || ownerRole
        ? initializeOrganizationSync({
            organizationName: organizationName ?? "DofeAgent",
            ownerName: ownerName ?? "Mina",
            ownerRole: ownerRole ?? "CEO",
          })
        : resetWorkspaceStateSync();

    writeData(format, {
      ok: true,
      organization: state.organizationName,
      owner: state.humanMembers[0]?.name ?? null,
      ownerRole: state.humanMembers[0]?.role ?? null,
      activeEmployees: state.activeEmployees.length,
      channels: state.channels.length,
    });
    return 0;
  }

  console.error("Usage: dofe-agent workspace status [--json]");
  console.error("   or: dofe-agent workspace context <subcommand> [options] [--json]");
  console.error(
    "   or: dofe-agent workspace init --reset [--json]",
  );
  console.error(
    "   or: dofe-agent workspace init --name <organization> --owner <name> --owner-role <role> [--json]",
  );
  return 1;
}

function runWorkspaceContextCommand(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const action = parsed.positionals[0];
  const agentName = resolveWorkspaceContextAgentName();

  if (!agentName) {
    console.error(
      `Workspace context is only available inside an agent task runtime. Missing ${WORKSPACE_CONTEXT_AGENT_ENV} / ${WORKSPACE_CONTEXT_TASK_ENV}.`,
    );
    return 1;
  }

  if (action === "list-entities") {
    writeData(format, listWorkspaceContextEntitiesSync(agentName));
    return 0;
  }

  if (action === "resolve-entity") {
    const query = getStringFlag(parsed.flags, "query")?.trim();
    if (!query) {
      console.error("Usage: dofe-agent workspace context resolve-entity --query <text> [--json]");
      return 1;
    }
    writeData(format, resolveWorkspaceContextEntitySync(agentName, query) ?? { entity: null });
    return 0;
  }

  if (action === "list-channels") {
    writeData(format, listWorkspaceContextChannelsSync(agentName));
    return 0;
  }

  if (action === "search-messages") {
    const query = getStringFlag(parsed.flags, "query")?.trim();
    if (!query) {
      console.error("Usage: dofe-agent workspace context search-messages --query <text> [--channel <name>] [--json]");
      return 1;
    }
    writeData(
      format,
      searchWorkspaceContextMessagesSync(agentName, query, getStringFlag(parsed.flags, "channel") ?? undefined),
    );
    return 0;
  }

  if (action === "list-documents") {
    writeData(format, listWorkspaceContextDocumentsSync(agentName, getStringFlag(parsed.flags, "channel") ?? undefined));
    return 0;
  }

  console.error("Usage:");
  console.error("  dofe-agent workspace context list-entities [--json]");
  console.error("  dofe-agent workspace context resolve-entity --query <text> [--json]");
  console.error("  dofe-agent workspace context list-channels [--json]");
  console.error("  dofe-agent workspace context search-messages --query <text> [--channel <name>] [--json]");
  console.error("  dofe-agent workspace context list-documents [--channel <name>] [--json]");
  return 1;
}

function resolveWorkspaceContextAgentName(): string | undefined {
  const directAgentName = process.env[WORKSPACE_CONTEXT_AGENT_ENV]?.trim();
  if (directAgentName) {
    return directAgentName;
  }

  const taskId = process.env[WORKSPACE_CONTEXT_TASK_ENV]?.trim();
  if (!taskId) {
    return undefined;
  }

  return readQueuedTaskSync(taskId)?.agentId;
}
