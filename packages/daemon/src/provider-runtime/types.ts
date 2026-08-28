// 3.5-4：自 provider-runtime.ts 拆出——runtime/任务/审批/结构化错误的全部
// 公共类型与 ProviderTaskExecutionError。
import type {
  DaemonProvider,
  EmployeeExecutionPolicy,
  ProviderErrorCategory,
  ProviderErrorCode,
  RuntimeAppContextEntry,
  RuntimeToolCapability,
  ToolSurfaceLaunchContext,
} from "@dofe-agent/domain";

export interface ProviderRuntimeRecord {
  id: string;
  workspaceId: string;
  provider: DaemonProvider;
  name: string;
  version?: string;
  status: "online" | "offline";
  deviceInfo?: string;
  metadata: {
    executablePath: string;
    mode: "local" | "remote";
    managedCredentialId?: string;
    provisioningState?: string;
    providerHealth?: Record<string, unknown>;
    providerVerificationRequestedAt?: string;
    openClawProfile?: string;
    openClawModel?: string;
    deepSeekHarnessHome?: string;
  };
}

export type RemoteRuntimeRecord = ProviderRuntimeRecord;

export interface DetectedProvider {
  provider: DaemonProvider;
  label: string;
  executablePath: string;
  version: string;
}

export interface ProviderTaskEvent {
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
  /** Correlates a tool_result with its tool_use (provider-side call id). */
  refId?: string;
}

export interface ProviderApprovalRequest {
  provider: DaemonProvider;
  runtimeId: string;
  sessionId?: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  contentPreview: string;
}

export interface ProviderApprovalDecision {
  decision: "approved" | "rejected";
  comment?: string;
}

export interface ProviderTaskOptions {
  sessionId?: string;
  /** Explicit task-scoped model selection; never mutate process.env for this. */
  modelId?: string;
  executionPolicy?: EmployeeExecutionPolicy;
  contextEnv?: Record<string, string>;
  /** Keys in `contextEnv` that were injected from per-employee Skill configuration; their values are always redacted from logs. */
  skillEnvKeys?: string[];
  taskTimeoutMs?: number;
  onEvent?: (event: ProviderTaskEvent) => void;
  onApprovalRequest?: (request: ProviderApprovalRequest) => Promise<ProviderApprovalDecision>;
  temporaryAllowedTools?: string[];
  runtimeApps?: RuntimeAppContextEntry[];
  /** Host path corresponding to the managed Runtime's mounted HOME/.local/bin. */
  runtimeAppBinDir?: string;
  /** Whether CLI-Hub apps are reachable from the daemon process for preflight diagnostics. */
  runtimeAppHostDiagnostics?: boolean;
  runtimeToolCapabilities?: RuntimeToolCapability[];
  /** Generic tool surface context; MCP is one implementation. */
  toolSurface?: ToolSurfaceLaunchContext;
  /** Loopback MCP gateway URL for a task-scoped session; passed to the provider as a one-shot MCP config. */
  mcpGatewayUrl?: string;
  /** Enables the unverified Codex MCP injection path only for an explicit experiment. */
  codexMcpInjectionEnabled?: boolean;
  /** Cancels the active Provider subprocess when the control plane stops the task. */
  signal?: AbortSignal;
}

export type ProviderTaskFailureCategory = ProviderErrorCategory | "auth" | "profile" | "model";

export interface ProviderTaskStructuredError {
  provider: DaemonProvider;
  code: ProviderErrorCode;
  category?: ProviderTaskFailureCategory;
  message: string;
  rawProviderMessage?: string;
}

export class ProviderTaskExecutionError extends Error {
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly providerError?: ProviderTaskStructuredError;

  constructor(
    message: string,
    metadata?: { sessionId?: string; workDir?: string; providerError?: ProviderTaskStructuredError },
  ) {
    super(message);
    this.name = "ProviderTaskExecutionError";
    this.sessionId = metadata?.sessionId;
    this.workDir = metadata?.workDir;
    this.providerError = metadata?.providerError;
  }
}
