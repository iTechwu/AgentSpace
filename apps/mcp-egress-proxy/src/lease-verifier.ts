import type { McpEgressErrorCode, McpEgressLeaseClaims, McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { verifyMcpEgressLease } from "@dofe-agent/services/mcp-center/egress";

export interface LeaseVerificationResult {
  ok: true;
  claims: McpEgressLeaseClaims;
  policy: McpEgressPolicyRevision;
}

export interface LeaseVerificationFailure {
  ok: false;
  code: McpEgressErrorCode;
  message: string;
}

export interface LeaseVerifierDependencies {
  leaseSecret: string;
  fetchPolicySnapshot: (policyRevisionId: string) => McpEgressPolicySnapshot | undefined | Promise<McpEgressPolicySnapshot | undefined>;
  isJtiRevoked?: (jti: string) => boolean | Promise<boolean>;
  consumeJti: (jti: string, exp: number) => boolean | Promise<boolean>;
}

/**
 * Verifies a lease token end-to-end: signature, TTL, revocation, JTI replay,
 * and matching policy revision presence.
 */
export async function verifyLeaseForRequest(
  token: string | undefined,
  deps: LeaseVerifierDependencies,
): Promise<LeaseVerificationResult | LeaseVerificationFailure> {
  if (!token) {
    return { ok: false, code: "mcp_egress.lease_missing", message: "Request is missing a DofeEgressLease token." };
  }

  const verified = verifyMcpEgressLease(token, deps.leaseSecret);
  if (!verified.ok) {
    return { ok: false, code: verified.code, message: verified.message };
  }

  const { claims, jti } = verified.lease;

  if (deps.isJtiRevoked && (await deps.isJtiRevoked(jti))) {
    return { ok: false, code: "mcp_egress.lease_revoked", message: "Lease has been revoked." };
  }

  const snapshot = await deps.fetchPolicySnapshot(claims.policyRevisionId);
  if (!snapshot) {
    return { ok: false, code: "mcp_egress.policy_mismatch", message: "Policy revision is not available to the proxy." };
  }
  if (snapshot.revoked) {
    return { ok: false, code: "mcp_egress.lease_revoked", message: "Policy revision has been revoked." };
  }
  if (
    snapshot.revision.id !== claims.policyRevisionId ||
    snapshot.revision.workspaceId !== claims.workspaceId ||
    snapshot.revision.connectionId !== claims.connectionId ||
    snapshot.revision.releaseId !== claims.releaseId
  ) {
    return { ok: false, code: "mcp_egress.policy_mismatch", message: "Lease does not match the policy revision." };
  }
  if (!(await deps.consumeJti(jti, claims.exp))) {
    return { ok: false, code: "mcp_egress.lease_replayed", message: "Lease JTI has already been consumed." };
  }

  return { ok: true, claims, policy: snapshot.revision };
}
