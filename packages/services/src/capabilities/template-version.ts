/**
 * Compare catalog template versions without relying on lexicographic ordering.
 * Catalog versions are normally SemVer; malformed legacy values sort below a
 * valid version and retain a deterministic lexical fallback among themselves.
 */
export function compareTemplateVersions(left: string, right: string): number {
  const leftParsed = parseTemplateVersion(left);
  const rightParsed = parseTemplateVersion(right);
  if (leftParsed && rightParsed) {
    for (let index = 0; index < 3; index += 1) {
      const difference = leftParsed.core[index] - rightParsed.core[index];
      if (difference !== 0) return difference;
    }
    if (leftParsed.prerelease === null && rightParsed.prerelease !== null) return 1;
    if (leftParsed.prerelease !== null && rightParsed.prerelease === null) return -1;
    if (leftParsed.prerelease && rightParsed.prerelease) {
      const length = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
      for (let index = 0; index < length; index += 1) {
        const leftPart = leftParsed.prerelease[index];
        const rightPart = rightParsed.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart.localeCompare(rightPart);
      }
    }
    return 0;
  }
  if (leftParsed) return 1;
  if (rightParsed) return -1;
  return left.localeCompare(right);
}

interface ParsedTemplateVersion {
  core: [number, number, number];
  prerelease: string[] | null;
}

function parseTemplateVersion(value: string): ParsedTemplateVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2] ?? "0"), Number(match[3] ?? "0")],
    prerelease: match[4] ? match[4].split(".") : null,
  };
}
