import type {
  ClaimManagedProvisioningTaskResponse,
  ClaimManagedSkillServiceOperationResponse,
  ClaimMcpConnectionOperationResponse,
  ClaimMcpTaskSessionResponse,
  ClaimRuntimeAppOperationResponse,
  ClaimSkillInstallationOperationResponse,
  ClaimTaskResponse,
  CompleteManagedSkillServiceOperationRequest,
  FailManagedSkillServiceOperationRequest,
  ClaimWorkspaceMountOperationResponse,
  CompleteManagedProvisioningStageRequest,
  CompleteManagedProvisioningStageResponse,
  CompleteManagedRuntimeCleanupRequest,
  CompleteMcpConnectionOperationRequest,
  CompleteRuntimeAppOperationRequest,
  CompleteSkillInstallationOperationRequest,
  CompleteTaskRequest,
  CompleteWorkspaceMountOperationRequest,
  CreateRuntimeApprovalRequest,
  CreateRuntimeApprovalResponse,
  DaemonTaskInputBundle,
  DaemonTaskOutputBundle,
  FailManagedProvisioningStageRequest,
  FailManagedProvisioningStageResponse,
  FailMcpConnectionOperationRequest,
  FailRuntimeAppOperationRequest,
  FailSkillInstallationOperationRequest,
  FailTaskRequest,
  FailWorkspaceMountOperationRequest,
  GetRuntimeApprovalResponse,
  HeartbeatDaemonResponse,
  HeartbeatDaemonRequest,
  ManagedCredentialBundleDocument,
  McpToolAuditReport,
  RegisterDaemonRequest,
  RegisterDaemonResponse,
  ReportMcpToolAuditsResponse,
  ReportTaskMessagesRequest,
  StartMcpConnectionOperationRequest,
  StartRuntimeAppOperationRequest,
  StartSkillInstallationOperationRequest,
  ValidateMcpConnectionForTaskRequest,
  ValidateMcpConnectionForTaskResponse,
} from "./daemon-api.ts";

export type {
  ClaimManagedProvisioningTaskResponse,
  ClaimMcpConnectionOperationResponse,
  ClaimMcpTaskSessionResponse,
  ClaimRuntimeAppOperationResponse,
  ClaimSkillInstallationOperationResponse,
  ClaimTaskResponse,
  ClaimWorkspaceMountOperationResponse,
  CompleteManagedProvisioningStageRequest,
  CompleteManagedProvisioningStageResponse,
  CompleteManagedRuntimeCleanupRequest,
  CompleteMcpConnectionOperationRequest,
  CompleteRuntimeAppOperationRequest,
  CompleteSkillInstallationOperationRequest,
  CompleteTaskRequest,
  CompleteWorkspaceMountOperationRequest,
  CreateRuntimeApprovalRequest,
  CreateRuntimeApprovalResponse,
  DaemonTaskInputBundle,
  DaemonTaskOutputBundle,
  FailManagedProvisioningStageRequest,
  FailManagedProvisioningStageResponse,
  FailMcpConnectionOperationRequest,
  FailRuntimeAppOperationRequest,
  FailSkillInstallationOperationRequest,
  FailTaskRequest,
  FailWorkspaceMountOperationRequest,
  GetRuntimeApprovalResponse,
  HeartbeatDaemonResponse,
  HeartbeatDaemonRequest,
  ManagedCredentialBundleDocument,
  McpToolAuditReport,
  RegisterDaemonRequest,
  RegisterDaemonResponse,
  ReportMcpToolAuditsResponse,
  ReportTaskMessagesRequest,
  StartMcpConnectionOperationRequest,
  StartRuntimeAppOperationRequest,
  StartSkillInstallationOperationRequest,
} from "./daemon-api.ts";

/**
 * Raised when the server rejects the daemon's bearer token (HTTP 401/403).
 * This is a fatal, non-recoverable condition: the token is missing, invalid, or
 * revoked, so the daemon must stop polling and prompt the operator to re-register
 * rather than spamming the server with requests that will never succeed.
 */
export class DaemonAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonAuthError";
    this.status = status;
  }
}

/**
 * Raised when the targeted runtime/task/operation no longer exists on the server
 * (HTTP 404). The caller should drop that resource from its poll set and continue;
 * the heartbeat reconciliation prunes deleted runtimes on the next successful beat.
 */
export class DaemonResourceGoneError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonResourceGoneError";
    this.status = status;
  }
}

/**
 * Raised when a runtime is not currently eligible to claim work (HTTP 409).
 * This is scoped to one runtime and must not prevent the node from polling
 * other runtimes that may be online.
 */
export class DaemonRuntimeUnavailableError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonRuntimeUnavailableError";
    this.status = status;
  }
}

export class HttpDaemonClient {
  private readonly serverUrl: string;
  private readonly daemonToken: string;
  private readonly retryDelayMs: number;
  private readonly maxRetryAttempts: number;

  constructor(
    serverUrl: string,
    daemonToken: string,
    options?: {
      retryDelayMs?: number;
      maxRetryAttempts?: number;
    },
  ) {
    this.serverUrl = serverUrl;
    this.daemonToken = daemonToken;
    this.retryDelayMs = options?.retryDelayMs ?? 250;
    this.maxRetryAttempts = Math.max(1, options?.maxRetryAttempts ?? 3);
  }

  async register(request: RegisterDaemonRequest): Promise<RegisterDaemonResponse> {
    return this.postJson("/api/daemon/register", request);
  }

  async sendHeartbeat(daemonKey: string): Promise<HeartbeatDaemonResponse> {
    return this.postJson("/api/daemon/heartbeat", { daemonKey }, { retryable: true });
  }

  async sendHeartbeatWithMetadata(
    daemonKey: string,
    metadata: Record<string, unknown>,
    runtimes?: HeartbeatDaemonRequest["runtimes"],
  ): Promise<HeartbeatDaemonResponse> {
    return this.postJson("/api/daemon/heartbeat", { daemonKey, metadata, runtimes }, { retryable: true });
  }

  async claimTask(runtimeId: string): Promise<ClaimTaskResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/tasks/claim`, {}, { retryable: true });
  }

  async claimRuntimeAppOperation(runtimeId: string): Promise<ClaimRuntimeAppOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/apps/operations/claim`, {}, { retryable: true });
  }

  async startRuntimeAppOperation(operationId: string, body: StartRuntimeAppOperationRequest = {}): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/start`, body);
  }

  async completeRuntimeAppOperation(operationId: string, body: CompleteRuntimeAppOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/complete`, body);
  }

  async failRuntimeAppOperation(operationId: string, body: FailRuntimeAppOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/runtime-app-operations/${encodeURIComponent(operationId)}/fail`, body);
  }

  async claimMcpConnectionOperation(runtimeId: string): Promise<ClaimMcpConnectionOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/mcp-operations/claim`, {}, { retryable: true });
  }

  async startMcpConnectionOperation(operationId: string, body: StartMcpConnectionOperationRequest = {}): Promise<void> {
    await this.postJson(`/api/daemon/mcp-operations/${encodeURIComponent(operationId)}/start`, body);
  }

  async completeMcpConnectionOperation(operationId: string, body: CompleteMcpConnectionOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/mcp-operations/${encodeURIComponent(operationId)}/complete`, body);
  }

  async failMcpConnectionOperation(operationId: string, body: FailMcpConnectionOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/mcp-operations/${encodeURIComponent(operationId)}/fail`, body);
  }

  async claimSkillInstallationOperation(runtimeId: string): Promise<ClaimSkillInstallationOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/skill-operations/claim`, {}, { retryable: true });
  }

  async startSkillInstallationOperation(operationId: string, body: StartSkillInstallationOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/skill-operations/${encodeURIComponent(operationId)}/start`, body);
  }

  /**
   * Heartbeat for the operation lease. Returns false when the lease was lost
   * (crash recovery re-queued the op) — the caller must abort execution.
   */
  async renewSkillInstallationOperationLease(operationId: string, claimGeneration: number): Promise<boolean> {
    try {
      await this.postJson(`/api/daemon/skill-operations/${encodeURIComponent(operationId)}/renew-lease`, { claimGeneration });
      return true;
    } catch (error) {
      if (error instanceof DaemonRuntimeUnavailableError) {
        return false;
      }
      throw error;
    }
  }

  async completeSkillInstallationOperation(operationId: string, body: CompleteSkillInstallationOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/skill-operations/${encodeURIComponent(operationId)}/complete`, body);
  }

  async failSkillInstallationOperation(operationId: string, body: FailSkillInstallationOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/skill-operations/${encodeURIComponent(operationId)}/fail`, body);
  }

  async claimSkillServiceOperation(runtimeId: string): Promise<ClaimManagedSkillServiceOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/skill-services/operations/claim`, {}, { retryable: true });
  }

  async startSkillServiceOperation(operationId: string, claimGeneration: number): Promise<void> {
    await this.postJson(`/api/daemon/skill-service-operations/${encodeURIComponent(operationId)}/start`, { claimGeneration });
  }

  async renewSkillServiceOperationLease(operationId: string, claimGeneration: number): Promise<boolean> {
    try {
      await this.postJson(`/api/daemon/skill-service-operations/${encodeURIComponent(operationId)}/renew-lease`, { claimGeneration });
      return true;
    } catch (error) {
      if (error instanceof DaemonRuntimeUnavailableError) {
        return false;
      }
      throw error;
    }
  }

  async completeSkillServiceOperation(operationId: string, body: CompleteManagedSkillServiceOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/skill-service-operations/${encodeURIComponent(operationId)}/complete`, body);
  }

  async getSkillServiceSecrets(operationId: string, claimGeneration: number): Promise<Record<string, string>> {
    const payload = await this.getJson<{ secrets: Record<string, string> }>(
      `/api/daemon/skill-service-operations/${encodeURIComponent(operationId)}/secrets?claimGeneration=${claimGeneration}`,
      { retryable: true },
    );
    return payload.secrets;
  }

  async failSkillServiceOperation(operationId: string, body: FailManagedSkillServiceOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/skill-service-operations/${encodeURIComponent(operationId)}/fail`, body);
  }

  async claimWorkspaceMountOperation(runtimeId: string): Promise<ClaimWorkspaceMountOperationResponse> {
    return this.postJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/workspace-mounts/claim`, {}, { retryable: true });
  }

  async completeWorkspaceMountOperation(operationId: string, body: CompleteWorkspaceMountOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/workspace-mounts/${encodeURIComponent(operationId)}/complete`, body);
  }

  async failWorkspaceMountOperation(operationId: string, body: FailWorkspaceMountOperationRequest): Promise<void> {
    await this.postJson(`/api/daemon/workspace-mounts/${encodeURIComponent(operationId)}/fail`, body);
  }

  async claimMcpTaskSession(taskId: string, attemptId: string): Promise<ClaimMcpTaskSessionResponse> {
    // attemptId makes the claim idempotent under HTTP retry: the server replays
    // the cached first result for the same attemptId, so a lost response does
    // not degrade the task to "no MCP".
    return this.postJson(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/mcp-session`,
      { attemptId },
      { retryable: true },
    );
  }

  async validateMcpConnectionForTask(
    taskId: string,
    connectionId: string,
    body: ValidateMcpConnectionForTaskRequest,
  ): Promise<ValidateMcpConnectionForTaskResponse> {
    return this.postJson(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/mcp-connections/${encodeURIComponent(connectionId)}/validate`,
      body,
      { retryable: true },
    );
  }

  async reportMcpToolAudits(taskId: string, audits: McpToolAuditReport[]): Promise<void> {
    if (audits.length === 0) return;
    const response = await this.postJson<ReportMcpToolAuditsResponse>(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/mcp-tool-audits`,
      { audits },
      { retryable: true },
    );
    const accepted = new Set(response.acceptedEventIds);
    for (const audit of audits) {
      if (!accepted.has(audit.eventId)) {
        throw new Error(`MCP audit server did not acknowledge ${audit.eventId}.`);
      }
    }
  }

  async startTask(taskId: string): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/start`, {});
  }

  async getInputBundle(taskId: string): Promise<DaemonTaskInputBundle> {
    return this.getJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/input-bundle`, { retryable: true });
  }

  async reportMessages(taskId: string, body: ReportTaskMessagesRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/messages`, body);
  }

  async createRuntimeApproval(taskId: string, body: CreateRuntimeApprovalRequest): Promise<CreateRuntimeApprovalResponse> {
    return this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/runtime-approvals`, body);
  }

  async getRuntimeApproval(taskId: string, approvalId: string): Promise<GetRuntimeApprovalResponse> {
    return this.getJson(
      `/api/daemon/tasks/${encodeURIComponent(taskId)}/runtime-approvals/${encodeURIComponent(approvalId)}`,
      { retryable: true },
    );
  }

  async uploadOutputBundle(taskId: string, bundle: DaemonTaskOutputBundle): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/output-bundle`, bundle);
  }

  async completeTask(taskId: string, body: CompleteTaskRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/complete`, body);
  }

  async failTask(taskId: string, body: FailTaskRequest): Promise<void> {
    await this.postJson(`/api/daemon/tasks/${encodeURIComponent(taskId)}/fail`, body);
  }

  async claimManagedProvisioningTask(): Promise<ClaimManagedProvisioningTaskResponse> {
    return this.postJson("/api/daemon/provisioning-tasks/claim", {}, { retryable: true });
  }

  async getManagedCredentialBundle(runtimeId: string): Promise<ManagedCredentialBundleDocument> {
    return this.getJson(`/api/daemon/runtimes/${encodeURIComponent(runtimeId)}/credential-bundle`, { retryable: true });
  }

  async completeManagedProvisioningStage(
    taskId: string,
    stage: string,
    body: CompleteManagedProvisioningStageRequest,
  ): Promise<CompleteManagedProvisioningStageResponse> {
    return this.postJson(
      `/api/daemon/provisioning-tasks/${encodeURIComponent(taskId)}/stages/${encodeURIComponent(stage)}/complete`,
      body,
    );
  }

  async failManagedProvisioningStage(
    taskId: string,
    stage: string,
    body: FailManagedProvisioningStageRequest,
  ): Promise<FailManagedProvisioningStageResponse> {
    return this.postJson(
      `/api/daemon/provisioning-tasks/${encodeURIComponent(taskId)}/stages/${encodeURIComponent(stage)}/fail`,
      body,
    );
  }

  async completeManagedRuntimeCleanupRequest(requestId: string, body: CompleteManagedRuntimeCleanupRequest): Promise<void> {
    await this.postJson(
      `/api/daemon/managed-runtime-cleanup-requests/${encodeURIComponent(requestId)}/complete`,
      body,
    );
  }

  async failManagedRuntimeCleanupRequest(requestId: string, body: { errorCode?: string; errorMessage?: string }): Promise<void> {
    await this.postJson(
      `/api/daemon/managed-runtime-cleanup-requests/${encodeURIComponent(requestId)}/fail`,
      body,
    );
  }

  async deregister(daemonKey: string, lastError?: string): Promise<void> {
    await this.postJson("/api/daemon/deregister", {
      daemonKey,
      lastError,
    });
  }

  private async getJson<T>(path: string, options?: { retryable?: boolean }): Promise<T> {
    return this.requestJson<T>(path, {
      method: "GET",
      retryable: options?.retryable,
    });
  }

  private async postJson<T>(path: string, body: unknown, options?: { retryable?: boolean }): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      retryable: options?.retryable,
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.daemonToken}`,
      "content-type": "application/json",
    };
  }

  private resolveUrl(path: string): string {
    return new URL(path, this.serverUrl).toString();
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string;
      retryable?: boolean;
    },
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      try {
        const response = await fetch(this.resolveUrl(path), {
          method: options.method,
          headers: this.buildHeaders(),
          body: options.body,
        });

        if (options.retryable && response.status >= 500 && attempt < this.maxRetryAttempts) {
          await sleep(this.retryDelayMs);
          continue;
        }

        return this.readJson<T>(response);
      } catch (error) {
        lastError = error;
        if (!options.retryable || attempt >= this.maxRetryAttempts) {
          throw error;
        }
        await sleep(this.retryDelayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Daemon client request failed.");
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // Ignore invalid error payloads.
      }
      if (response.status === 401 || response.status === 403) {
        throw new DaemonAuthError(message, response.status);
      }
      if (response.status === 404) {
        throw new DaemonResourceGoneError(message, response.status);
      }
      if (response.status === 409) {
        throw new DaemonRuntimeUnavailableError(message, response.status);
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
