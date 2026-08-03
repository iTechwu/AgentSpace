/**
 * System dependency catalog (P1-4): the allow-list a skill's `system:<name>`
 * dependency resolves against. The resolver is fail-closed — an unknown or
 * not-allow-install package is rejected rather than silently passed to a
 * runner. The catalog is curated and security-reviewed; adding an entry is a
 * deliberate act, not inferred from a registry.
 */

export type SystemDependencyRisk = "low" | "medium" | "high";

export interface SystemDependencyCatalogEntry {
  /** Canonical name used in `system:<name>` declarations and `command -v` checks. */
  name: string;
  aliases?: string[];
  description: string;
  /** Binary(s) that must exist in the runner image (`command -v`). */
  binaries: string[];
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
  packageManagers: Array<{ manager: "apt" | "apk"; package: string }>;
  risk: SystemDependencyRisk;
  allowInstall: boolean;
}

const CATALOG: SystemDependencyCatalogEntry[] = [
  { name: "ffmpeg", description: "Audio/video transcoding and capture", binaries: ["ffmpeg", "ffprobe"], apt: "ffmpeg", apk: "ffmpeg", risk: "low", allowInstall: true },
  { name: "graphviz", description: "Graph visualization and layout", binaries: ["dot", "neato"], apt: "graphviz", apk: "graphviz", risk: "low", allowInstall: true },
  { name: "poppler-utils", aliases: ["pdftoppm", "pdfinfo"], description: "PDF rendering and metadata utilities", binaries: ["pdftoppm", "pdfinfo"], apt: "poppler-utils", apk: "poppler-utils", risk: "low", allowInstall: true },
  { name: "imagemagick", description: "Image manipulation suite", binaries: ["convert", "magick"], apt: "imagemagick", apk: "imagemagick", risk: "low", allowInstall: true },
  { name: "unzip", description: "ZIP archive extraction", binaries: ["unzip"], apt: "unzip", apk: "unzip", risk: "low", allowInstall: true },
  { name: "jq", description: "JSON query and transformation", binaries: ["jq"], apt: "jq", apk: "jq", risk: "low", allowInstall: true },
  { name: "ghostscript", description: "PostScript/PDF interpreter", binaries: ["gs"], apt: "ghostscript", apk: "ghostscript", risk: "low", allowInstall: true },
  { name: "sqlite3", description: "SQLite database CLI", binaries: ["sqlite3"], apt: "sqlite3", apk: "sqlite3", risk: "low", allowInstall: true },
  { name: "libreoffice", description: "Office document conversion (headless)", binaries: ["libreoffice", "soffice"], apt: "libreoffice-core", apk: "libreoffice", risk: "medium", allowInstall: true },
  { name: "chromium", aliases: ["google-chrome", "chrome"], description: "Headless browser rendering", binaries: ["chromium", "chromium-browser"], apt: "chromium", apk: "chromium", risk: "medium", allowInstall: true },
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
    packageManagers: [
      ...(entry.apt ? [{ manager: "apt" as const, package: entry.apt }] : []),
      ...(entry.apk ? [{ manager: "apk" as const, package: entry.apk }] : []),
    ],
    risk: entry.risk,
    allowInstall: entry.allowInstall,
  }));
}
