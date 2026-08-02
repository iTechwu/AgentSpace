/** Process-local one-shot lease guard. A multi-replica proxy needs a shared atomic implementation. */
export class InMemoryJtiReplayGuard {
  private readonly expirations = new Map<string, number>();
  private consumeCount = 0;

  consume(jti: string, exp: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const existingExpiration = this.expirations.get(jti);
    if (existingExpiration !== undefined && existingExpiration > nowSeconds) return false;

    this.expirations.set(jti, exp);
    this.consumeCount += 1;
    if (this.consumeCount % 256 === 0 || this.expirations.size > 10_000) {
      for (const [candidate, expiration] of this.expirations) {
        if (expiration <= nowSeconds) this.expirations.delete(candidate);
      }
    }
    return true;
  }
}
