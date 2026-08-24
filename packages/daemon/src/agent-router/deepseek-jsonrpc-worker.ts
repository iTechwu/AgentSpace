// P2b bounded worker: a persistent `dsh-jsonrpc-agent` process that reuses one
// runtime across tasks. Sessions are multiplexed over the single stdio JSON-RPC
// transport; each task's Skill/credential/gateway environment is isolated per
// session via the fork's `session/prompt` environment overlay (deny-list).
//
// This module is feature-flag gated and default-off: the production queue keeps
// using the one-shot headless/JSON-RPC path until real carrier evidence exists.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentRouterEvent } from "./types.ts";

const JSONRPC_VERSION = "2.0";
const SERVER_INFO = { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } as const;
const MAX_FRAME_BYTES = 1024 * 1024;

/** A server-to-client notification forwarded from the shared transport. */
export interface DeepSeekJsonRpcWorkerNotification {
  sessionId?: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface DeepSeekJsonRpcWorkerOptions {
  /** Verified runtime executable (absolute path, execute bit, fixed interpreter). */
  executablePath: string;
  /** Task work directory, resolved absolute. */
  cwd: string;
  /** Base process environment (PATH, proxy, non-secret bootstrap). */
  env: NodeJS.ProcessEnv;
  /** Model every session routes on (`deepseek-v4-flash` / `deepseek-v4-pro`). */
  model: string;
  /** Upper bound on concurrently-active sessions for this worker. */
  maxSessions: number;
  /** Forwarded session/approval notifications for the caller to map/audit. */
  onNotification?: (notification: DeepSeekJsonRpcWorkerNotification) => void;
  /** Normalized timeline events (text_delta, tool_*, approval_requested, harness_*). */
  onEvent?: (event: AgentRouterEvent) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One turn's accumulation state: final assistant text + idle receipt. */
interface ActiveTurn {
  sessionId: string;
  outputText: string;
  idleResolve: () => void;
  idleReject: (error: Error) => void;
}

/**
 * A bounded, persistent DeepSeek Harness JSON-RPC runtime worker.
 *
 * The process is spawned once and reused for many sessions. Recovery is
 * fail-closed: an unexpected exit rejects every pending request/turn with a
 * structured transport error; callers may then resume a persisted session on a
 * fresh worker or start a new conversation.
 */
export class DeepSeekJsonRpcWorker {
  private child: ChildProcess | undefined;
  private stdoutBuffer = "";
  private requestSerial = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private initialized = false;
  private closed = false;
  private exitError: Error | undefined;
  private readonly options: DeepSeekJsonRpcWorkerOptions;

  constructor(options: DeepSeekJsonRpcWorkerOptions) {
    this.options = options;
  }

  /** Spawn the runtime and perform the one-time `initialize` handshake. */
  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new Error("DeepSeek Harness JSON-RPC worker is closed");
    const child = spawn(this.options.executablePath, [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.options.onEvent?.({ type: "harness_started", harness: "deepseek-harness", pid: child.pid, command: [this.options.executablePath] });
    child.stdin?.on("error", () => {});
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(String(chunk)));
    child.once("error", (error) => this.failActive(error));
    child.once("exit", (code) => {
      this.failActive(new Error(`DeepSeek Harness JSON-RPC runtime exited with code ${String(code)}.`));
    });
    const result = await this.request("initialize", {
      cwd: this.options.cwd,
      provider: "deepseek-official",
      model: this.options.model,
      protocolVersions: [JSONRPC_VERSION],
    });
    const info = (result as { serverInfo?: { name?: unknown; version?: unknown } }).serverInfo;
    if (info?.name !== SERVER_INFO.name || info?.version !== SERVER_INFO.version) {
      await this.stop();
      throw new Error(`DeepSeek Harness JSON-RPC runtime returned an unexpected server identity: ${JSON.stringify(result)}`);
    }
    this.initialized = true;
  }

  /** Run one prompt on one session and resolve with the final assistant text. */
  async runSession(sessionId: string, prompt: string, environment?: Readonly<Record<string, string>>): Promise<string> {
    // Bound check and reservation run synchronously before any await, so
    // concurrent callers cannot oversubscribe the worker.
    if (this.closed) throw new Error("DeepSeek Harness JSON-RPC worker is closed");
    if (this.exitError !== undefined) throw this.exitError;
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`DeepSeek Harness JSON-RPC session already active: ${sessionId}`);
    }
    if (this.activeTurns.size >= this.options.maxSessions) {
      throw new Error(`DeepSeek Harness JSON-RPC worker is at its session bound (${this.options.maxSessions}).`);
    }
    let turn: ActiveTurn | undefined;
    const turnPromise = new Promise<string>((resolve, reject) => {
      const reserved: ActiveTurn = {
        sessionId,
        outputText: "",
        idleResolve: () => {
          this.activeTurns.delete(sessionId);
          resolve(reserved.outputText);
        },
        idleReject: (error) => {
          this.activeTurns.delete(sessionId);
          reject(error);
        },
      };
      turn = reserved;
      this.activeTurns.set(sessionId, reserved);
    });
    await this.start();
    try {
      const receipt = await this.request("session/prompt", {
        sessionId,
        contentBlocks: [{ type: "text", text: prompt }],
        ...(environment === undefined ? {} : { environment }),
      });
      if ((receipt as { messageId?: unknown }).messageId === undefined) {
        throw new Error(`DeepSeek Harness JSON-RPC session/prompt returned no message id: ${JSON.stringify(receipt)}`);
      }
    } catch (error) {
      this.activeTurns.delete(sessionId);
      throw error;
    }
    return turnPromise;
  }

  /** Resume one persisted session into this worker's process (crash recovery). */
  async resumeSession(sessionId: string): Promise<void> {
    await this.start();
    const result = await this.request("session/resume", { sessionId });
    if ((result as { resumed?: unknown }).resumed !== true) {
      throw new Error(`DeepSeek Harness JSON-RPC session/resume returned no resume receipt: ${JSON.stringify(result)}`);
    }
  }

  /** Cancel the active turn for one session, keeping the runtime alive. */
  async cancelSession(sessionId: string, reason: "user" | "timeout" | "parent" | "operator" = "operator"): Promise<void> {
    await this.request("session/cancel", { sessionId, reason, keepInbox: false });
  }

  /** Dispose one session's agent without closing the runtime process. */
  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId });
    this.activeTurns.delete(sessionId);
  }

  /** Answer one pending approval question for a session. */
  async respondApproval(sessionId: string, approvalId: string, outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable"): Promise<void> {
    await this.request("approval/respond", { sessionId, approvalId, outcome });
  }

  /** Shut the runtime down and reject all outstanding work. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.initialized && this.child && this.child.exitCode === null) {
      try {
        await this.request("shutdown");
      } catch {
        // Best-effort; the process is torn down below regardless.
      }
    }
    this.child?.kill("SIGTERM");
    this.failActive(new Error("DeepSeek Harness JSON-RPC worker stopped."));
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        this.failActive(new Error("DeepSeek Harness JSON-RPC frame exceeded the 1 MiB size limit."));
        return;
      }
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
        message = parsed as Record<string, unknown>;
      } catch (error) {
        this.failActive(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if ("id" in message) {
        const id = String(message.id);
        const pending = this.pending.get(id);
        if (pending === undefined) continue;
        this.pending.delete(id);
        if (message.error !== undefined) pending.reject(new Error(String((message.error as { message?: unknown })?.message ?? message.error)));
        else pending.resolve(message.result);
        continue;
      }
      if (typeof message.method !== "string") continue;
      this.onNotification(message.method, message.params as Record<string, unknown> | undefined);
    }
  }

  private onNotification(method: string, params: Record<string, unknown> | undefined): void {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    if (sessionId !== undefined) {
      this.options.onNotification?.({ sessionId, method, params });
      if (method === "session.status" && params?.status === "idle") {
        this.activeTurns.get(sessionId)?.idleResolve();
      } else if (method === "session.event") {
        const event = params?.event as { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } } | undefined;
        if (event?.type === "assistant/message") {
          const text = (event.data?.message?.content ?? [])
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("");
          const turn = sessionId !== undefined ? this.activeTurns.get(sessionId) : undefined;
          if (turn !== undefined) turn.outputText = text;
          if (text) this.options.onEvent?.({ type: "text_delta", text });
        }
      } else if (method === "approval.request") {
        this.options.onEvent?.({
          type: "approval_requested",
          toolName: typeof params?.toolName === "string" ? params.toolName : "tool",
          contentPreview: typeof params?.reason === "string" ? params.reason : "",
        });
      }
    }
    this.options.onNotification?.({ method, params });
  }

  private request(method: string, params?: object): Promise<unknown> {
    const id = `req-${this.requestSerial++}`;
    const message: Record<string, unknown> = { jsonrpc: JSONRPC_VERSION, id, method };
    if (params !== undefined) message.params = params;
    return new Promise<unknown>((resolve, reject) => {
      if (this.exitError !== undefined) {
        reject(this.exitError);
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.writeFrame(message);
    });
  }

  private writeFrame(message: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failActive(error: Error): void {
    if (this.exitError === undefined) this.exitError = error;
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    for (const turn of [...this.activeTurns.values()]) turn.idleReject(error);
    this.activeTurns.clear();
  }
}

/** Mint a fresh, opaque DeepSeek session id (matches the one-shot path). */
export function mintDeepSeekSessionId(): string {
  return `dofe-task-${randomUUID()}`;
}

/**
 * Whether the bounded-worker path may replace one-shot JSON-RPC execution.
 * Defaults off; the production queue stays one-shot until real carrier evidence
 * and provider-session mapping land end-to-end.
 */
export function isDeepSeekBoundedWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DOFE_AGENT_DEEPSEEK_BOUNDED_WORKER_ENABLED === "1";
}
