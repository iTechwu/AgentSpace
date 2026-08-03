interface JtiBinding {
  expiration: number;
  sessionId?: string;
}

/** Lease-to-session guard with optional single-replica file persistence. */
export class InMemoryJtiReplayGuard {
  private readonly bindings = new Map<string, JtiBinding>();
  private readonly stateFile?: string;
  private consumeCount = 0;

  constructor(options: { stateFile?: string } = {}) {
    this.stateFile = options.stateFile;
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Array<[string, JtiBinding]>;
      for (const [jti, binding] of parsed) {
        if (typeof jti === "string" && Number.isSafeInteger(binding?.expiration)) this.bindings.set(jti, binding);
      }
    } catch {
      // First boot or an unreadable state file starts empty and fails closed for future bindings.
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

  private persist(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporaryFile = `${this.stateFile}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(Array.from(this.bindings.entries())), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, this.stateFile);
  }
}
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
