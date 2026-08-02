import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";

/**
 * In-memory policy cache. The proxy never reads the application database;
 * snapshots are pushed by the control plane through a small sync interface.
 */
export class McpEgressPolicyCache {
  private readonly revisions = new Map<string, McpEgressPolicySnapshot>();

  set(snapshot: McpEgressPolicySnapshot): void {
    this.revisions.set(snapshot.revision.id, snapshot);
  }

  get(policyRevisionId: string): McpEgressPolicySnapshot | undefined {
    return this.revisions.get(policyRevisionId);
  }

  revoke(policyRevisionId: string): void {
    const snapshot = this.revisions.get(policyRevisionId);
    if (snapshot) {
      this.revisions.set(policyRevisionId, { ...snapshot, revoked: true });
    }
  }

  list(): McpEgressPolicySnapshot[] {
    return Array.from(this.revisions.values());
  }
}
