import { rotateMcpEncryptionKeySync } from "@dofe-agent/services";
import type { OutputFormat } from "../lib/format.ts";

export function runMcpCommand(subcommand: string | undefined, args: string[], format: OutputFormat): number {
  if (subcommand !== "rotate-key") {
    process.stderr.write("Unknown MCP subcommand. Use: rotate-key\n");
    return 1;
  }
  const workspaceIndex = args.indexOf("--workspace-id");
  const workspaceId = workspaceIndex >= 0 ? args[workspaceIndex + 1]?.trim() : undefined;
  if (workspaceIndex >= 0 && !workspaceId) {
    process.stderr.write("--workspace-id requires a value.\n");
    return 1;
  }
  const result = rotateMcpEncryptionKeySync({ workspaceId });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `MCP key rotation complete: version=${result.keyVersion}, secrets=${result.rotatedSecrets}, grants=${result.rotatedSessionGrants}\n`,
    );
  }
  return 0;
}

/**
 * `dofe-agent mcp-bridge --registry <path>`
 *
 * Reserved for the isolated Runtime MCP gateway. The former implementation
 * read a decrypted registry in the Provider's own UID, which does not protect
 * the connection secrets from that Provider process.
 */
export async function runMcpBridgeCommand(_args: string[]): Promise<number> {
  process.stderr.write("mcp-bridge is disabled until the isolated Runtime MCP gateway is available.\n");
  return 1;
}
