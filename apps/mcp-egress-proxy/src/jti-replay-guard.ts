interface JtiBinding {
  expiration: number;
  sessionId?: string;
}

/** Process-local lease-to-session guard. A multi-replica proxy needs a shared atomic implementation. */
export class InMemoryJtiReplayGuard {
  private readonly bindings = new Map<string, JtiBinding>();
  private consumeCount = 0;

  bind(jti: string, sessionId: string | undefined, exp: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const existing = this.bindings.get(jti);
    if (existing && existing.expiration > nowSeconds) {
      return sessionId !== undefined && existing.sessionId === sessionId;
    }

    this.bindings.set(jti, { expiration: exp, ...(sessionId ? { sessionId } : {}) });
    this.consumeCount += 1;
    if (this.consumeCount % 256 === 0 || this.bindings.size > 10_000) {
      for (const [candidate, binding] of this.bindings) {
        if (binding.expiration <= nowSeconds) this.bindings.delete(candidate);
      }
    }
    return true;
  }
}
