import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpEgressPolicyRevision, McpEgressPolicySnapshot } from "@dofe-agent/domain";

/**
 * Policy/revoke cache (P1-1 持久重放). The proxy never reads the application
 * database — snapshots are pushed by the control plane. When a `stateFile` is
 * configured, every set/revoke is written through to disk so a proxy restart
 * replays the pushed policy + revocation feed instead of starting empty.
 */
export class McpEgressPolicyCache {
  private readonly revisions = new Map<string, McpEgressPolicySnapshot>();
  private readonly stateFile?: string;

  constructor(options: { stateFile?: string } = {}) {
    this.stateFile = options.stateFile;
    if (this.stateFile) {
      this.load();
      this.persist();
    }
  }

  set(snapshot: McpEgressPolicySnapshot): void {
    this.revisions.set(snapshot.revision.id, snapshot);
    this.persist();
  }

  get(policyRevisionId: string): McpEgressPolicySnapshot | undefined {
    return this.revisions.get(policyRevisionId);
  }

  revoke(policyRevisionId: string): void {
    const snapshot = this.revisions.get(policyRevisionId);
    if (snapshot) {
      this.revisions.set(policyRevisionId, { ...snapshot, revoked: true });
      this.persist();
    }
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
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const item of parsed) {
        const snapshot = item as Partial<McpEgressPolicySnapshot>;
        if (snapshot?.revision && typeof snapshot.revision.id === "string") {
          const { staticHeaders: _legacyStaticHeaders, ...durableSnapshot } = snapshot as McpEgressPolicySnapshot;
          this.revisions.set(snapshot.revision.id, durableSnapshot);
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
    const durableSnapshots = this.list().map(({ staticHeaders: _staticHeaders, ...snapshot }) => snapshot);
    const temporaryFile = `${this.stateFile}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify(durableSnapshots), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, this.stateFile);
  }
}

export { type McpEgressPolicyRevision, type McpEgressPolicySnapshot };
