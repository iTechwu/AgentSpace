/** Converts an encoded route segment to the workspace slug stored in the database. */
export function normalizeWorkspaceSlugParam(workspaceSlug: string): string {
  try {
    return decodeURIComponent(workspaceSlug);
  } catch {
    // Malformed URLs should use normal missing-workspace handling instead of returning 500.
    return workspaceSlug;
  }
}
