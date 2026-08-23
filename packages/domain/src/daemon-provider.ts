export const DAEMON_PROVIDER_IDS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "opencode",
  "openclaw",
  "nanobot",
  "hermes",
  "deepseek-harness",
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
  "deepseek-harness": "DeepSeek Harness",
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
  // Codex CLI uses the OpenAI Responses API (/v1/responses), not Chat
  // Completions. The runtime credential must explicitly allow this protocol.
  codex: ["openai_response"],
  antigravity: ["openai"],
  gemini: ["gemini"],
  opencode: ["openai"],
  openclaw: ["openai"],
  nanobot: ["openai"],
  hermes: ["openai"],
  "deepseek-harness": ["deepseek_native"],
};

const DAEMON_PROVIDER_DEFAULT_MODELS: Partial<Record<DaemonProvider, string>> = {
  codex: "gpt-5.6-terra",
  "deepseek-harness": "deepseek-v4-flash",
};

export interface ProviderLocalModel {
  id: string;
  displayName: string;
  protocol: string;
}

const DAEMON_PROVIDER_LOCAL_MODELS: Partial<Record<DaemonProvider, ProviderLocalModel[]>> = {
  "deepseek-harness": [
    { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", protocol: "deepseek_native" },
    { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", protocol: "deepseek_native" },
  ],
};

export function resolveProviderProtocols(provider: DaemonProvider): string[] {
  return DAEMON_PROVIDER_PROTOCOLS[provider] ?? [];
}

export function resolveProviderDefaultModel(provider: DaemonProvider): string | undefined {
  return DAEMON_PROVIDER_DEFAULT_MODELS[provider];
}

export function resolveProviderLocalModels(provider: DaemonProvider): ProviderLocalModel[] {
  return (DAEMON_PROVIDER_LOCAL_MODELS[provider] ?? []).map((model) => ({ ...model }));
}

export function resolveLocalModelsForProtocols(protocols: string[]): ProviderLocalModel[] {
  const requestedProtocols = new Set(protocols);
  return DAEMON_PROVIDER_IDS.flatMap((provider) => resolveProviderLocalModels(provider))
    .filter((model) => requestedProtocols.has(model.protocol));
}
