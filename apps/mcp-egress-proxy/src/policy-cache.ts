import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { readJsonStateFile, writeJsonStateFile } from "./atomic-json-state.ts";

interface PersistedPolicyState {
  version: 1;
  snapshots: McpEgressPolicySnapshot[];
  revokedRevisionIds: string[];
}

/**
 * Policy/revoke cache (P1-1 持久重放). The proxy never reads the application
 * database — snapshots are pushed by the control plane. When a `stateFile` is
 * configured, every set/revoke is written through to disk so a proxy restart
 * replays the pushed policy + revocation feed instead of starting empty.
 */
export class McpEgressPolicyCache {
  private readonly revisions = new Map<string, McpEgressPolicySnapshot>();
  private readonly revokedRevisionIds = new Set<string>();
  private readonly stateFile?: string;

  constructor(options: { stateFile?: string } = {}) {
    this.stateFile = options.stateFile;
    if (this.stateFile) {
      this.load();
      this.persist();
    }
  }

  set(snapshot: McpEgressPolicySnapshot): void {
    const id = snapshot.revision.id;
    const nextRevisions = new Map(this.revisions);
    const nextRevokedRevisionIds = new Set(this.revokedRevisionIds);
    const revoked = snapshot.revoked || nextRevokedRevisionIds.has(id) || nextRevisions.get(id)?.revoked === true;
    if (revoked) nextRevokedRevisionIds.add(id);
    nextRevisions.set(id, revoked ? { ...snapshot, revoked: true } : snapshot);
    this.persist(nextRevisions, nextRevokedRevisionIds);
    this.commit(nextRevisions, nextRevokedRevisionIds);
  }

  get(policyRevisionId: string): McpEgressPolicySnapshot | undefined {
    return this.revisions.get(policyRevisionId);
  }

  revoke(policyRevisionId: string): void {
    const nextRevisions = new Map(this.revisions);
    const nextRevokedRevisionIds = new Set(this.revokedRevisionIds);
    nextRevokedRevisionIds.add(policyRevisionId);
    const snapshot = nextRevisions.get(policyRevisionId);
    if (snapshot) {
      nextRevisions.set(policyRevisionId, { ...snapshot, revoked: true });
    }
    this.persist(nextRevisions, nextRevokedRevisionIds);
    this.commit(nextRevisions, nextRevokedRevisionIds);
  }

  list(): McpEgressPolicySnapshot[] {
    return Array.from(this.revisions.values());
  }

  private load(): void {
    if (!this.stateFile) {
      return;
    }
    const parsed = readJsonStateFile(this.stateFile);
    if (parsed === undefined) return;
    const legacySnapshots = Array.isArray(parsed) ? parsed : undefined;
    const state = isPersistedPolicyState(parsed) ? parsed : undefined;
    if (!legacySnapshots && !state) throw new Error("MCP egress policy state has an unsupported format.");
    for (const id of state?.revokedRevisionIds ?? []) {
      this.revokedRevisionIds.add(id);
    }
    for (const item of legacySnapshots ?? state!.snapshots) {
      const snapshot = item as Partial<McpEgressPolicySnapshot>;
      if (!snapshot?.revision || typeof snapshot.revision.id !== "string") {
        throw new Error("MCP egress policy state contains an invalid snapshot.");
      }
      const {
        staticHeaders: _legacyStaticHeaders,
        oauthGrantReference: _legacyOauthGrantReference,
        privateCaPem: _legacyPrivateCaPem,
        ...durableSnapshot
      } = snapshot as McpEgressPolicySnapshot;
      if (durableSnapshot.revoked) this.revokedRevisionIds.add(snapshot.revision.id);
      this.revisions.set(
        snapshot.revision.id,
        this.revokedRevisionIds.has(snapshot.revision.id) ? { ...durableSnapshot, revoked: true } : durableSnapshot,
      );
    }
  }

  private persist(
    revisions: ReadonlyMap<string, McpEgressPolicySnapshot> = this.revisions,
    revokedRevisionIds: ReadonlySet<string> = this.revokedRevisionIds,
  ): void {
    if (!this.stateFile) {
      return;
    }
    const durableSnapshots = Array.from(revisions.values()).map(({
      staticHeaders: _staticHeaders,
      oauthGrantReference: _oauthGrantReference,
      privateCaPem: _privateCaPem,
      ...snapshot
    }) => snapshot);
    const state: PersistedPolicyState = {
      version: 1,
      snapshots: durableSnapshots,
      revokedRevisionIds: Array.from(revokedRevisionIds),
    };
    writeJsonStateFile(this.stateFile, state);
  }

  private commit(
    revisions: ReadonlyMap<string, McpEgressPolicySnapshot>,
    revokedRevisionIds: ReadonlySet<string>,
  ): void {
    this.revisions.clear();
    for (const [id, snapshot] of revisions) this.revisions.set(id, snapshot);
    this.revokedRevisionIds.clear();
    for (const id of revokedRevisionIds) this.revokedRevisionIds.add(id);
  }
}

function isPersistedPolicyState(value: unknown): value is PersistedPolicyState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedPolicyState>;
  return candidate.version === 1 && Array.isArray(candidate.snapshots) && Array.isArray(candidate.revokedRevisionIds)
    && candidate.revokedRevisionIds.every((id) => typeof id === "string");
}

export { type McpEgressPolicyRevision, type McpEgressPolicySnapshot };
