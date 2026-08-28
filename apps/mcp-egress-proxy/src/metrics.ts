/**
 * Process-local metrics for the egress proxy (P1-1 指标). Exposed via the
 * GET /metrics route for scraping; a multi-replica deployment aggregates these
 * externally (the proxy itself stays DB-free and stateless beyond the cache).
 */
export interface McpEgressMetricsSnapshot {
  requestsTotal: number;
  acceptedTotal: number;
  rejectedTotal: number;
  revokedTotal: number;
  upstreamErrors: number;
  /** Rolling recent latency histogram buckets in ms (≤100, ≤500, ≤2000, >2000). */
  latencyBuckets: Array<{ label: string; count: number }>;
  startedAt: string;
}

export class McpEgressMetrics {
  private requestsTotal = 0;
  private acceptedTotal = 0;
  private rejectedTotal = 0;
  private revokedTotal = 0;
  private upstreamErrors = 0;
  private latency: Array<{ label: string; count: number }> = [
    { label: "le=100", count: 0 },
    { label: "le=500", count: 0 },
    { label: "le=2000", count: 0 },
    { label: "le=+Inf", count: 0 },
  ];
  private readonly startedAt = new Date().toISOString();

  recordRequest(): void {
    this.requestsTotal += 1;
  }

  recordAccept(latencyMs: number): void {
    this.acceptedTotal += 1;
    const bucket = latencyMs <= 100 ? 0 : latencyMs <= 500 ? 1 : latencyMs <= 2000 ? 2 : 3;
    this.latency[bucket]!.count += 1;
  }

  recordReject(): void {
    this.rejectedTotal += 1;
  }

  recordRevoke(): void {
    this.revokedTotal += 1;
  }

  recordUpstreamError(): void {
    this.upstreamErrors += 1;
  }

  snapshot(): McpEgressMetricsSnapshot {
    return {
      requestsTotal: this.requestsTotal,
      acceptedTotal: this.acceptedTotal,
      rejectedTotal: this.rejectedTotal,
      revokedTotal: this.revokedTotal,
      upstreamErrors: this.upstreamErrors,
      latencyBuckets: this.latency.map((bucket) => ({ ...bucket })),
      startedAt: this.startedAt,
    };
  }
}
