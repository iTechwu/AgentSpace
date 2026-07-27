export const DAEMON_PROVIDER_IDS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "openclaw",
  "nanobot",
  "hermes",
] as const;

export type DaemonProvider = typeof DAEMON_PROVIDER_IDS[number];

const DAEMON_PROVIDER_LABELS: Record<DaemonProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  antigravity: "Antigravity CLI",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  nanobot: "NanoBot",
  hermes: "Hermes Agent",
};

export function isDaemonProvider(value: string): value is DaemonProvider {
  return DAEMON_PROVIDER_IDS.includes(value as DaemonProvider);
}

export function formatDaemonProviderLabel(provider: string): string {
  return isDaemonProvider(provider) ? DAEMON_PROVIDER_LABELS[provider] : provider;
}

/**
 * Default model-gateway protocol each runtime type speaks. Drives the
 * `protocols` capability stamped onto a managed RuntimeCredential and used to
 * filter the model catalog shown in the create-runtime wizard. Phase 2 keeps a
 * single primary protocol per provider; Phase 3 may widen this.
 */
export const DAEMON_PROVIDER_PROTOCOLS: Record<DaemonProvider, string[]> = {
  claude: ["anthropic"],
  codex: ["openai"],
  antigravity: ["openai"],
  gemini: ["gemini"],
  opencode: ["openai"],
  openclaw: ["openai"],
  nanobot: ["openai"],
  hermes: ["openai"],
};

export function resolveProviderProtocols(provider: DaemonProvider): string[] {
  return DAEMON_PROVIDER_PROTOCOLS[provider] ?? [];
}
