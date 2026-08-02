import type { McpEgressLeaseClaims } from "@dofe-agent/domain";
import { hashMcpEgressAuditValue } from "@dofe-agent/services/mcp-center/egress";

export interface McpEgressAuditRecord {
  connectionId: string;
  releaseId: string;
  policyRevisionId: string;
  leaseJtiHash: string;
  upstreamHostHash: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  sizeBucket: "0-1k" | "1k-10k" | "10k-100k" | "100k-1m" | "1m+" | "error";
  outcome: "succeeded" | "rejected" | "upstream_failed";
  rejectedReasonCode?: string;
  timestamp: string;
}

function bucketBytes(bytes: number): McpEgressAuditRecord["sizeBucket"] {
  if (bytes < 0) return "error";
  if (bytes <= 1024) return "0-1k";
  if (bytes <= 10 * 1024) return "1k-10k";
  if (bytes <= 100 * 1024) return "10k-100k";
  if (bytes <= 1024 * 1024) return "100k-1m";
  return "1m+";
}

export interface McpEgressAuditSink {
  record(record: McpEgressAuditRecord): void | Promise<void>;
}

export class ConsoleMcpEgressAuditSink implements McpEgressAuditSink {
  record(record: McpEgressAuditRecord): void {
    // Structured log line; no URL query, payload, Authorization or lease text.
    console.log(JSON.stringify(record));
  }
}

export function buildUpstreamAuditRecord(
  claims: McpEgressLeaseClaims,
  upstreamHost: string,
  method: string,
  statusCode: number,
  latencyMs: number,
  bytes: number,
  outcome: McpEgressAuditRecord["outcome"],
  rejectedReasonCode?: string,
): McpEgressAuditRecord {
  return {
    connectionId: claims.connectionId,
    releaseId: claims.releaseId,
    policyRevisionId: claims.policyRevisionId,
    leaseJtiHash: hashMcpEgressAuditValue(claims.jti),
    upstreamHostHash: hashMcpEgressAuditValue(upstreamHost),
    method,
    statusCode,
    latencyMs,
    sizeBucket: bucketBytes(bytes),
    outcome,
    rejectedReasonCode,
    timestamp: new Date().toISOString(),
  };
}

export function buildRejectedAuditRecord(
  claims: McpEgressLeaseClaims | undefined,
  upstreamHost: string,
  method: string,
  reasonCode: string,
): McpEgressAuditRecord {
  return {
    connectionId: claims?.connectionId ?? "unknown",
    releaseId: claims?.releaseId ?? "unknown",
    policyRevisionId: claims?.policyRevisionId ?? "unknown",
    leaseJtiHash: claims ? hashMcpEgressAuditValue(claims.jti) : "unknown",
    upstreamHostHash: hashMcpEgressAuditValue(upstreamHost),
    method,
    statusCode: 0,
    latencyMs: 0,
    sizeBucket: "error",
    outcome: "rejected",
    rejectedReasonCode: reasonCode,
    timestamp: new Date().toISOString(),
  };
}
