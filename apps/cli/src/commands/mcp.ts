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
