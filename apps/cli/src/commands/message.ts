import { postMessageSync, sendChannelHumanMessageSync, readWorkspaceSnapshotSync } from "@dofe-agent/services";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runMessageCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "list") {
    writeData(format, readWorkspaceSnapshotSync().messages);
    return 0;
  }

  if (subcommand === "post") {
    const { flags } = parseArgs(args);
    const channel = getStringFlag(flags, "channel");
    const speaker = getStringFlag(flags, "speaker") ?? "Operator · CLI";
    const summary = getStringFlag(flags, "summary");
    const roleFlag = getStringFlag(flags, "role");
    const role = roleFlag === "agent" ? "agent" : "human";

    if (!channel || !summary) {
      console.error(
        'Usage: dofe-agent message post --channel <name> --summary <text> [--speaker <name>] [--role human|agent] [--json]',
      );
      return 1;
    }

    const state = role === "human"
      ? sendChannelHumanMessageSync(channel, speaker, summary)
      : postMessageSync({ channel, speaker, role, summary });

    writeData(format, {
      ok: true,
      channel,
      speaker,
      role,
      totalMessages: state.messages.length,
    });
    return 0;
  }

  console.error("Usage: dofe-agent message list [--json]");
  console.error(
    "   or: dofe-agent message post --channel <name> --summary <text> [--speaker <name>] [--role human|agent] [--json]",
  );
  return 1;
}

