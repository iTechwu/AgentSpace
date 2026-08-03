import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";

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
    const revoked = snapshot.revoked || this.revokedRevisionIds.has(id) || this.revisions.get(id)?.revoked === true;
    if (revoked) this.revokedRevisionIds.add(id);
    this.revisions.set(id, revoked ? { ...snapshot, revoked: true } : snapshot);
    this.persist();
  }

  get(policyRevisionId: string): McpEgressPolicySnapshot | undefined {
    return this.revisions.get(policyRevisionId);
  }

  revoke(policyRevisionId: string): void {
    this.revokedRevisionIds.add(policyRevisionId);
    const snapshot = this.revisions.get(policyRevisionId);
    if (snapshot) {
      this.revisions.set(policyRevisionId, { ...snapshot, revoked: true });
    }
    this.persist();
  }

  list(): McpEgressPolicySnapshot[] {
    return Array.from(this.revisions.values());
  }

  private load(): void {
    if (!this.stateFile) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown;
      const legacySnapshots = Array.isArray(parsed) ? parsed : undefined;
      const state = isPersistedPolicyState(parsed) ? parsed : undefined;
      if (!legacySnapshots && !state) return;
      for (const id of state?.revokedRevisionIds ?? []) {
        this.revokedRevisionIds.add(id);
      }
      for (const item of legacySnapshots ?? state!.snapshots) {
        const snapshot = item as Partial<McpEgressPolicySnapshot>;
        if (snapshot?.revision && typeof snapshot.revision.id === "string") {
          const {
            staticHeaders: _legacyStaticHeaders,
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
    } catch {
      // No persisted state yet (first boot) or unreadable file — start empty.
    }
  }

  private persist(): void {
    if (!this.stateFile) {
      return;
    }
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const durableSnapshots = this.list().map(({
      staticHeaders: _staticHeaders,
      privateCaPem: _privateCaPem,
      ...snapshot
    }) => snapshot);
    const state: PersistedPolicyState = {
      version: 1,
      snapshots: durableSnapshots,
      revokedRevisionIds: Array.from(this.revokedRevisionIds),
    };
    const temporaryFile = `${this.stateFile}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, this.stateFile);
  }
}

function isPersistedPolicyState(value: unknown): value is PersistedPolicyState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedPolicyState>;
  return candidate.version === 1 && Array.isArray(candidate.snapshots) && Array.isArray(candidate.revokedRevisionIds)
    && candidate.revokedRevisionIds.every((id) => typeof id === "string");
}

export { type McpEgressPolicyRevision, type McpEgressPolicySnapshot };
