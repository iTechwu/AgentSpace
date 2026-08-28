/**
 * System dependency catalog (P1-4): the allow-list a skill's `system:<name>`
 * dependency resolves against. The resolver is fail-closed — an unknown or
 * not-allow-install package is rejected rather than silently passed to a
 * runner. The catalog is curated and security-reviewed; adding an entry is a
 * deliberate act, not inferred from a registry.
 */

export type SystemDependencyRisk = "low" | "medium" | "high";

/**
 * How `binaries[]` is probed inside the runner image:
 *   - `"all"` requires EVERY binary present (a multi-tool suite like
 *     ffmpeg/ffprobe or poppler's pdftoppm/pdfinfo is verified whole — a
 *     partially installed package is treated as missing).
 *   - `"any"` accepts ANY ONE binary present (alternative names for the same
 *     tool, e.g. ImageMagick v6 `convert` vs v7 `magick`, or distro-named
 *     `chromium` vs `chromium-browser`).
 * Defaults to `"all"` so a new multi-binary entry fails closed until its
 * semantics are deliberately set.
 */
export type SystemDependencyProbeMode = "all" | "any";

export interface SystemDependencyCatalogEntry {
  /** Canonical name used in `system:<name>` declarations and `command -v` checks. */
  name: string;
  aliases?: string[];
  description: string;
  /** Binary(s) that must exist in the runner image (`command -v`). */
  binaries: string[];
  /** See {@link SystemDependencyProbeMode}. Defaults to `"all"`. */
  probeMode?: SystemDependencyProbeMode;
  apt?: string;
  apk?: string;
  risk: SystemDependencyRisk;
  /** When false, the package may be listed but not installed by a runner. */
  allowInstall: boolean;
}

export interface SystemDependencyResolution {
  name: string;
  description: string;
  binaries: string[];
  probeMode: SystemDependencyProbeMode;
  packageManagers: Array<{ manager: "apt" | "apk"; package: string }>;
  risk: SystemDependencyRisk;
  allowInstall: boolean;
}

const CATALOG: SystemDependencyCatalogEntry[] = [
  // curl is NOT auto-exposed to agents. A skill that needs it declares
  // `system:curl`; the daemon verifies the binary exists inside the immutable
  // Runner image (it installs nothing and never runs a download script). Note
  // the Runner is `--network none`, so this only confirms presence — runtime
  // HTTP egress is unavailable unless a future restricted-egress runner profile
  // is attached. The daemon's own curl use goes through a node subprocess and
  // never reaches the agent.
  { name: "curl", description: "HTTP client for approved runtime integrations", binaries: ["curl"], apt: "curl", apk: "curl", risk: "medium", allowInstall: true },
  { name: "ffmpeg", description: "Audio/video transcoding and capture", binaries: ["ffmpeg", "ffprobe"], probeMode: "all", apt: "ffmpeg", apk: "ffmpeg", risk: "low", allowInstall: true },
  { name: "graphviz", description: "Graph visualization and layout", binaries: ["dot", "neato"], probeMode: "all", apt: "graphviz", apk: "graphviz", risk: "low", allowInstall: true },
  { name: "poppler-utils", aliases: ["pdftoppm", "pdfinfo"], description: "PDF rendering and metadata utilities", binaries: ["pdftoppm", "pdfinfo"], probeMode: "all", apt: "poppler-utils", apk: "poppler-utils", risk: "low", allowInstall: true },
  { name: "imagemagick", description: "Image manipulation suite", binaries: ["convert", "magick"], probeMode: "any", apt: "imagemagick", apk: "imagemagick", risk: "low", allowInstall: true },
  { name: "unzip", description: "ZIP archive extraction", binaries: ["unzip"], apt: "unzip", apk: "unzip", risk: "low", allowInstall: true },
  { name: "jq", description: "JSON query and transformation", binaries: ["jq"], apt: "jq", apk: "jq", risk: "low", allowInstall: true },
  { name: "ghostscript", description: "PostScript/PDF interpreter", binaries: ["gs"], apt: "ghostscript", apk: "ghostscript", risk: "low", allowInstall: true },
  { name: "sqlite3", description: "SQLite database CLI", binaries: ["sqlite3"], apt: "sqlite3", apk: "sqlite3", risk: "low", allowInstall: true },
  { name: "libreoffice", description: "Office document conversion (headless)", binaries: ["libreoffice", "soffice"], probeMode: "any", apt: "libreoffice-core", apk: "libreoffice", risk: "medium", allowInstall: true },
  { name: "chromium", aliases: ["google-chrome", "chrome"], description: "Headless browser rendering", binaries: ["chromium", "chromium-browser"], probeMode: "any", apt: "chromium", apk: "chromium", risk: "medium", allowInstall: true },
];

/**
 * Resolves a declared system dependency against the allow-list catalog.
 * Returns null for unknown packages → the caller fails closed. An entry with
 * `allowInstall: false` still resolves (for validation/audit) but must never
 * be installed by a runner.
 */
export function resolveSystemDependencySync(name: string): SystemDependencyResolution | null {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  const entry = CATALOG.find(
    (candidate) => candidate.name === normalized || candidate.aliases?.includes(normalized),
  );
  if (!entry) {
    return null;
  }
  return {
    name: entry.name,
    description: entry.description,
    binaries: entry.binaries,
    probeMode: entry.probeMode ?? "all",
    packageManagers: [
      ...(entry.apt ? [{ manager: "apt" as const, package: entry.apt }] : []),
      ...(entry.apk ? [{ manager: "apk" as const, package: entry.apk }] : []),
    ],
    risk: entry.risk,
    allowInstall: entry.allowInstall,
  };
}

/** All catalog entries, for admin review / UI. */
export function listSystemDependencyCatalogSync(): SystemDependencyResolution[] {
  return CATALOG.map((entry) => ({
    name: entry.name,
    description: entry.description,
    binaries: entry.binaries,
    probeMode: entry.probeMode ?? "all",
    packageManagers: [
      ...(entry.apt ? [{ manager: "apt" as const, package: entry.apt }] : []),
      ...(entry.apk ? [{ manager: "apk" as const, package: entry.apk }] : []),
    ],
    risk: entry.risk,
    allowInstall: entry.allowInstall,
  }));
}
