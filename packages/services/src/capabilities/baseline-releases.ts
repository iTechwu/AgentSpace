/**
 * Governed baseline releases (docs/0811/cli-install Phase 7 / baseline rollout).
 *
 * The Runtime baseline auto-rollout installs missing base tools into a runtime.
 * To honor the immutable-release gate, every installable baseline tool MUST be
 * pinned to a specific artifact + integrity digest — no mutable `latest`, no
 * unverified download. Ops governs the pins either per-tool via env
 * (`DOFE_AGENT_BASELINE_<TOOL>_ARTIFACT_URL` + `..._INTEGRITY`) or via a
 * versioned JSON registry (`DOFE_AGENT_BASELINE_RELEASES_JSON`).
 *
 * Resolution order per tool:
 *   1. per-tool env URL+integrity (fast override)
 *   2. governed JSON registry
 *   3. null — the tool has no governed release and must fail closed (npm/python
 *      are image-level; uv/cli-hub fall back to an explicitly-unpinned command
 *      plan only when ops has not yet governed them).
 */

export type BaselineTool = "npm" | "python" | "uv" | "cli_hub";

export interface BaselineRelease {
  tool: BaselineTool;
  version: string;
  artifactUrl: string;
  /** sha256-<64 hex> — the daemon verifies the download against this digest. */
  integrity: string;
  /** Reserved until the runtime plan carries a verifiable signature payload. */
  signatureRequired?: boolean;
}

const INTEGRITY_PATTERN = /^sha256-[A-Fa-f0-9]{64}$/;
const TOOLS: BaselineTool[] = ["npm", "python", "uv", "cli_hub"];
// Keep the producer-side URL policy identical to the daemon consumer. A valid
// digest cannot compensate for an unbounded redirect/host policy.
const BASELINE_ARTIFACT_ALLOWED_HOSTS = new Set([
  "registry.npmjs.org",
  "files.pythonhosted.org",
  "nodejs.org",
  "python.org",
  "www.python.org",
]);

function envKeyFor(tool: BaselineTool, suffix: "ARTIFACT_URL" | "ARTIFACT_INTEGRITY"): string {
  // npm's artifact is the node runtime — the env prefix is NODE.
  const prefix = tool === "cli_hub" ? "CLIHUB" : tool === "npm" ? "NODE" : tool.toUpperCase();
  return `DOFE_AGENT_BASELINE_${prefix}_${suffix}`;
}

function parseRegistryJson(raw: string | undefined): BaselineRelease[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const registry = parsed as { releases?: Record<string, unknown> };
    if (!registry.releases || typeof registry.releases !== "object") return [];
    const out: BaselineRelease[] = [];
    for (const tool of TOOLS) {
      const entry = registry.releases[tool];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.version !== "string" || typeof record.artifactUrl !== "string" || typeof record.integrity !== "string") {
        continue;
      }
      const release: BaselineRelease = {
        tool,
        version: record.version.trim(),
        artifactUrl: record.artifactUrl.trim(),
        integrity: record.integrity.trim(),
      };
      if (typeof record.signatureRequired === "boolean") {
        release.signatureRequired = record.signatureRequired;
      }
      if (isValidBaselineRelease(release)) out.push(release);
    }
    return out;
  } catch {
    return [];
  }
}

function isValidBaselineRelease(release: BaselineRelease): boolean {
  try {
    const url = new URL(release.artifactUrl);
    return url.protocol === "https:"
      && BASELINE_ARTIFACT_ALLOWED_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash
      && INTEGRITY_PATTERN.test(release.integrity)
      && TOOLS.includes(release.tool);
  } catch {
    return false;
  }
}

const governedRegistry: BaselineRelease[] = parseRegistryJson(
  process.env.DOFE_AGENT_BASELINE_RELEASES_JSON,
);

/**
 * Resolves the governed release for a baseline tool, or null when no pin is
 * configured. Env per-tool override wins over the JSON registry.
 */
export function resolveBaselineRelease(tool: BaselineTool): BaselineRelease | null {
  const envUrl = process.env[envKeyFor(tool, "ARTIFACT_URL")]?.trim();
  const envIntegrity = process.env[envKeyFor(tool, "ARTIFACT_INTEGRITY")]?.trim();
  if (envUrl && envIntegrity) {
    const release: BaselineRelease = {
      tool,
      version: "env",
      artifactUrl: envUrl,
      integrity: envIntegrity,
    };
    return isValidBaselineRelease(release) ? release : null;
  }
  // Validate the resolved entry so the test seam / any caller cannot inject a
  // malformed pin (fail closed on non-https or bad integrity).
  const found = governedRegistry.find((entry) => entry.tool === tool);
  return found && isValidBaselineRelease(found) ? found : null;
}

/** Test seam: swap the governed registry without touching env. */
export function setBaselineRegistryForTests(releases: BaselineRelease[]): void {
  governedRegistry.length = 0;
  governedRegistry.push(...releases);
}
