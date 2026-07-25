import {
  createChannelSync,
  deleteChannelSync,
  renameChannelSync,
  readWorkspaceSnapshotSync,
} from "@dofe-agent/services";
import { parseArgs, getStringFlag } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runChannelCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "list") {
    writeData(format, readWorkspaceSnapshotSync().channels);
    return 0;
  }

  if (subcommand === "create") {
    const { flags } = parseArgs(args);
    const name = getStringFlag(flags, "name");

    if (!name) {
      console.error('Usage: dofe-agent channel create --name <name> [--json]');
      return 1;
    }

    const state = createChannelSync({ name });
    writeData(format, {
      ok: true,
      channel: name,
      totalChannels: state.channels.length,
    });
    return 0;
  }

  if (subcommand === "delete") {
    const { flags } = parseArgs(args);
    const name = getStringFlag(flags, "name");
    if (!name) {
      console.error('Usage: dofe-agent channel delete --name <name> [--json]');
      return 1;
    }

    const state = deleteChannelSync(name);
    writeData(format, {
      ok: true,
      channel: name,
      totalChannels: state.channels.length,
    });
    return 0;
  }

  if (subcommand === "rename") {
    const { flags } = parseArgs(args);
    const name = getStringFlag(flags, "name");
    const nextName = getStringFlag(flags, "to");
    if (!name || !nextName) {
      console.error('Usage: dofe-agent channel rename --name <name> --to <next-name> [--json]');
      return 1;
    }

    const state = renameChannelSync(name, nextName);
    writeData(format, {
      ok: true,
      from: name,
      to: nextName,
      totalChannels: state.channels.length,
    });
    return 0;
  }

  console.error("Usage: dofe-agent channel list [--json]");
  console.error("   or: dofe-agent channel create --name <name> [--json]");
  console.error("   or: dofe-agent channel delete --name <name> [--json]");
  console.error("   or: dofe-agent channel rename --name <name> --to <next-name> [--json]");
  return 1;
}
