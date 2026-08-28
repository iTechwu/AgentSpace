export function buildWorkspacePath(workspaceSlug: string, path = "/"): string {
  const normalizedWorkspaceSlug = workspaceSlug.trim();
  if (!normalizedWorkspaceSlug) {
    throw new Error("workspaceSlug is required.");
  }

  const [pathnamePart, queryPart] = path.split("?");
  const normalizedPathname = normalizeWorkspacePathname(pathnamePart || "/");
  const prefix = `/w/${encodeURIComponent(normalizedWorkspaceSlug)}`;

  return `${prefix}${normalizedPathname === "/" ? "" : normalizedPathname}${queryPart ? `?${queryPart}` : ""}`;
}

export function canonicalWorkspacePath(input: {
  requestedWorkspaceIdentifier: string;
  workspaceId: string;
  pathname: string;
  search?: string;
  hash?: string;
}): string | null {
  const requestedWorkspaceIdentifier = input.requestedWorkspaceIdentifier.trim();
  const workspaceId = input.workspaceId.trim();
  if (!requestedWorkspaceIdentifier || !workspaceId || requestedWorkspaceIdentifier === workspaceId) {
    return null;
  }

  const pathname = normalizeWorkspacePathname(input.pathname);
  return buildWorkspacePath(workspaceId, pathname) + (input.search ?? "") + (input.hash ?? "");
}

export function parseWorkspacePathname(pathname: string): {
  workspaceSlug?: string;
  appPath: string;
} {
  const match = pathname.match(/^\/w\/([^/]+)(?:\/(.*))?$/);
  if (!match) {
    return {
      appPath: normalizeWorkspacePathname(pathname),
    };
  }

  let workspaceSlug: string;
  try {
    workspaceSlug = decodeURIComponent(match[1] ?? "");
  } catch {
    return {
      appPath: normalizeWorkspacePathname(pathname),
    };
  }
  const nestedPath = match[2] ? `/${match[2]}` : "/";

  return {
    workspaceSlug,
    appPath: normalizeWorkspacePathname(nestedPath),
  };
}

function normalizeWorkspacePathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
