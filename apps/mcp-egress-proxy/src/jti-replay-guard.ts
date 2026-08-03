import { readJsonStateFile, writeJsonStateFile } from "./atomic-json-state.ts";

interface JtiBinding {
  expiration: number;
  sessionId?: string;
  taskCallConsumed?: boolean;
}

/** Lease-to-session guard with optional single-replica file persistence. */
export class SingleReplicaJtiReplayGuard {
  private readonly bindings = new Map<string, JtiBinding>();
  private readonly stateFile?: string;
  private consumeCount = 0;

  constructor(options: { stateFile?: string } = {}) {
    this.stateFile = options.stateFile;
    if (!this.stateFile) return;
    const parsed = readJsonStateFile(this.stateFile);
    if (parsed === undefined) return;
    if (!Array.isArray(parsed)) throw new Error("MCP egress JTI state must be an array.");
    for (const item of parsed) {
      if (!isJtiBindingEntry(item)) throw new Error("MCP egress JTI state contains an invalid binding.");
      this.bindings.set(item[0], item[1]);
    }
  }

  bind(jti: string, sessionId: string | undefined, exp: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const existing = this.bindings.get(jti);
    if (existing && existing.expiration > nowSeconds) {
      return sessionId !== undefined && existing.sessionId === sessionId;
    }

    this.bindings.set(jti, { expiration: exp, ...(sessionId ? { sessionId } : {}) });
    this.persist();
    this.consumeCount += 1;
    if (this.consumeCount % 256 === 0 || this.bindings.size > 10_000) {
      for (const [candidate, binding] of this.bindings) {
        if (binding.expiration <= nowSeconds) this.bindings.delete(candidate);
      }
    }
    return true;
  }

  consumeTaskCall(jti: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const binding = this.bindings.get(jti);
    if (!binding || binding.expiration <= nowSeconds || binding.taskCallConsumed) return false;
    this.bindings.set(jti, { ...binding, taskCallConsumed: true });
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.stateFile) return;
    writeJsonStateFile(this.stateFile, Array.from(this.bindings.entries()));
  }
}

function isJtiBindingEntry(value: unknown): value is [string, JtiBinding] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string") return false;
  const binding = value[1] as Partial<JtiBinding> | undefined;
  return Boolean(binding && Number.isSafeInteger(binding.expiration)
    && (binding.sessionId === undefined || typeof binding.sessionId === "string")
    && (binding.taskCallConsumed === undefined || typeof binding.taskCallConsumed === "boolean"));
}
