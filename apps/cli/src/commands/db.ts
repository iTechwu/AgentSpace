import {
  getDatabaseStatusSync,
  readWorkspaceSync,
} from "@dofe-agent/db";
import { scanStorageArtifactsSync } from "@dofe-agent/services/storage/storage-scan";
import { purgeWorkspaceStorageSync } from "@dofe-agent/services/storage/workspace-purge";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runDatabaseCommand(subcommand: string | undefined, args: string[], format: OutputFormat): number {
  if (subcommand === "status") {
    writeData(format, getDatabaseStatusSync());
    return 0;
  }

  if (subcommand === "storage-scan") {
    writeData(format, scanStorageArtifactsSync());
    return 0;
  }

  if (subcommand === "workspace-purge") {
    const { flags } = parseArgs(args);
    const workspaceIdentifier = getStringFlag(flags, "id");
    const force = flags.force === true;

    if (!workspaceIdentifier || !force) {
      console.error("Usage: dofe-agent db workspace-purge --id <workspace-id> --force [--json]");
      return 1;
    }

    const workspace = readWorkspaceSync(workspaceIdentifier.trim());
    if (!workspace) {
      throw new Error(`Workspace "${workspaceIdentifier}" does not exist.`);
    }

    writeData(format, {
      ok: true,
      workspaceId: workspace.id,
      result: purgeWorkspaceStorageSync(workspace.id),
    });
    return 0;
  }

  console.error("Usage: dofe-agent db status [--json]");
  console.error("   or: dofe-agent db storage-scan [--json]");
  console.error("   or: dofe-agent db workspace-purge --id <workspace-id> --force [--json]");
  return 1;
}
