import { buildWorkspacePath, parseWorkspacePathname } from "@/features/auth/workspace-paths";

export const WORKSPACE_MODULE_IDS = [
  "inbox",
  "im",
  "contacts",
  "approvals",
  "task-board",
  "agents",
  "skills",
  "knowledge",
  "market",
  "performance",
  "org-chart",
  "costs",
  "tables",
  "automations",
  "calendar",
  "templates",
  "settings",
] as const;

export type WorkspaceModuleId = (typeof WORKSPACE_MODULE_IDS)[number];

export type WorkspaceModuleSearchParamsInput =
  | string
  | URLSearchParams
  | ReadonlyArray<[string, string]>
  | Record<string, string | string[] | null | undefined>
  | {
      get(name: string): string | null;
      toString(): string;
    };

export interface WorkspaceModuleRouteState {
  workspaceSlug?: string;
  appPath: string;
  moduleId: WorkspaceModuleId | null;
  searchParams: URLSearchParams;
  conversationView: "all" | "direct";
  agentsMode: "agent" | "showcase" | "container";
  knowledgeView: "knowledge" | "documents";
  settingsPath: string[];
  isSettingsPath: boolean;
  isConversationLayout: boolean;
  isHumanContactsView: boolean;
  isDigitalContactsView: boolean;
}

export interface WorkspaceModuleHrefInput {
  moduleId: WorkspaceModuleId;
  query?: WorkspaceModuleSearchParamsInput;
  settingsPath?: string | string[];
}

const WORKSPACE_MODULE_PATHS: Record<WorkspaceModuleId, string> = {
  inbox: "/inbox",
  im: "/im",
  contacts: "/contacts",
  approvals: "/approvals",
  "task-board": "/task-board",
  agents: "/agents",
  skills: "/skills",
  knowledge: "/knowledge",
  market: "/market",
  performance: "/performance",
  "org-chart": "/org-chart",
  costs: "/costs",
  tables: "/tables",
  automations: "/automations",
  calendar: "/calendar",
  templates: "/templates",
  settings: "/settings",
};

const MODULE_QUERY_KEY_ORDER: Partial<Record<WorkspaceModuleId, string[]>> = {
  im: ["view", "context", "focus", "tab", "doc"],
  contacts: ["view", "focus", "tab", "doc"],
  agents: ["mode", "create", "focus"],
  knowledge: ["view", "page", "document"],
  inbox: ["filter", "focus"],
  settings: ["section"],
  skills: ["create"],
};

export function isWorkspaceModuleId(value: string | null | undefined): value is WorkspaceModuleId {
  return WORKSPACE_MODULE_IDS.includes(value as WorkspaceModuleId);
}

export function getWorkspaceModulePath(moduleId: WorkspaceModuleId): string {
  return WORKSPACE_MODULE_PATHS[moduleId];
}

export function parseWorkspaceModulePath(
  pathname: string,
  searchParams?: WorkspaceModuleSearchParamsInput,
): WorkspaceModuleRouteState {
  const { workspaceSlug, appPath } = parseWorkspacePathname(pathname);
  const moduleId = resolveWorkspaceModuleId(appPath);
  const normalizedSearchParams = normalizeWorkspaceModuleQuery(moduleId, searchParams);
  const conversationView = moduleId === "im" && normalizedSearchParams.get("view") === "direct" ? "direct" : "all";
  const agentsMode =
    moduleId === "agents" && normalizedSearchParams.get("mode") === "showcase"
      ? "showcase"
      : moduleId === "agents" && normalizedSearchParams.get("mode") === "container"
        ? "container"
        : "agent";
  const knowledgeView = moduleId === "knowledge" && normalizedSearchParams.get("view") === "documents" ? "documents" : "knowledge";
  const settingsPath = moduleId === "settings" ? splitAppPath(appPath).slice(1) : [];
  const isHumanContactsView = moduleId === "contacts";
  const isDigitalContactsView =
    moduleId === "im" &&
    conversationView === "direct" &&
    normalizedSearchParams.get("context") === "contacts";

  return {
    workspaceSlug,
    appPath,
    moduleId,
    searchParams: normalizedSearchParams,
    conversationView,
    agentsMode,
    knowledgeView,
    settingsPath,
    isSettingsPath: moduleId === "settings",
    isConversationLayout: moduleId === "inbox" || moduleId === "im" || moduleId === "contacts",
    isHumanContactsView,
    isDigitalContactsView,
  };
}

export function parseWorkspaceModuleHref(href: string): WorkspaceModuleRouteState {
  const parsed = new URL(href, "https://agent-space.local");
  return parseWorkspaceModulePath(parsed.pathname, parsed.searchParams);
}

export function buildWorkspaceModuleHref(
  workspaceSlug: string,
  input: WorkspaceModuleId | WorkspaceModuleHrefInput,
): string {
  const normalizedInput: WorkspaceModuleHrefInput = typeof input === "string" ? { moduleId: input } : input;
  const pathname = buildWorkspaceModulePath(normalizedInput);
  const query = normalizeWorkspaceModuleQuery(normalizedInput.moduleId, normalizedInput.query);
  const queryString = query.toString();

  return buildWorkspacePath(workspaceSlug, `${pathname}${queryString ? `?${queryString}` : ""}`);
}

export function buildWorkspaceModuleDataQuery(routeState: Pick<WorkspaceModuleRouteState, "moduleId" | "searchParams" | "settingsPath">): URLSearchParams {
  const params = new URLSearchParams(routeState.searchParams.toString());
  if (routeState.moduleId === "settings") {
    params.set("section", routeState.settingsPath[0] ?? "account");
  }

  return normalizeWorkspaceModuleQuery(routeState.moduleId, params);
}

export function normalizeWorkspaceModuleQuery(
  moduleId: WorkspaceModuleId | null,
  input?: WorkspaceModuleSearchParamsInput,
): URLSearchParams {
  const params = readSearchParams(input);
  if (!moduleId) {
    return params;
  }

  const keyOrder = MODULE_QUERY_KEY_ORDER[moduleId] ?? [];
  if (keyOrder.length === 0) {
    return params;
  }

  const normalized = new URLSearchParams();
  const consumedKeys = new Set<string>();
  for (const key of keyOrder) {
    const values = params.getAll(key).filter((value) => shouldKeepWorkspaceModuleQueryValue(moduleId, key, value));
    for (const value of values) {
      normalized.append(key, value);
    }
    consumedKeys.add(key);
  }

  const extraEntries = Array.from(params.entries())
    .filter(([key, value]) => !consumedKeys.has(key) && shouldKeepWorkspaceModuleQueryValue(moduleId, key, value))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyComparison = leftKey.localeCompare(rightKey);
      return keyComparison === 0 ? leftValue.localeCompare(rightValue) : keyComparison;
    });
  for (const [key, value] of extraEntries) {
    normalized.append(key, value);
  }

  return normalized;
}

function resolveWorkspaceModuleId(appPath: string): WorkspaceModuleId | null {
  const [firstSegment] = splitAppPath(appPath);
  if (!firstSegment) {
    return null;
  }

  return isWorkspaceModuleId(firstSegment) ? firstSegment : null;
}

function buildWorkspaceModulePath(input: WorkspaceModuleHrefInput): string {
  const basePath = getWorkspaceModulePath(input.moduleId);
  if (input.moduleId !== "settings") {
    return basePath;
  }

  const settingsSegments = typeof input.settingsPath === "string"
    ? splitAppPath(input.settingsPath)
    : input.settingsPath ?? [];
  const normalizedSettingsSegments = settingsSegments.map((segment) => segment.trim()).filter(Boolean);

  return normalizedSettingsSegments.length > 0
    ? `${basePath}/${normalizedSettingsSegments.map(encodeURIComponent).join("/")}`
    : basePath;
}

function splitAppPath(appPath: string): string[] {
  return appPath.split("/").map((segment) => segment.trim()).filter(Boolean);
}

function shouldKeepWorkspaceModuleQueryValue(moduleId: WorkspaceModuleId, key: string, value: string): boolean {
  if (moduleId === "im" && key === "view") {
    return value === "direct";
  }
  if (moduleId === "im" && key === "context") {
    return value === "contacts";
  }
  if (moduleId === "contacts" && key === "view") {
    return value === "direct" || value === "digital";
  }
  if (moduleId === "agents" && key === "mode") {
    return value === "agent" || value === "showcase" || value === "container";
  }
  if (moduleId === "knowledge" && key === "view") {
    return value === "documents";
  }
  if (moduleId === "inbox" && key === "filter") {
    return value === "notification" || value === "task" || value === "channel" || value === "activity";
  }
  if (moduleId === "skills" && key === "create") {
    return value === "skill";
  }
  return value.length > 0;
}

function readSearchParams(input?: WorkspaceModuleSearchParamsInput): URLSearchParams {
  if (!input) {
    return new URLSearchParams();
  }
  if (typeof input === "string") {
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }
  if (input instanceof URLSearchParams) {
    return new URLSearchParams(input.toString());
  }
  if (Array.isArray(input)) {
    return new URLSearchParams(input);
  }
  if (isSearchParamsLike(input)) {
    return new URLSearchParams(input.toString());
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          params.append(key, item);
        }
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      params.set(key, value);
    }
  }
  return params;
}

function isSearchParamsLike(input: WorkspaceModuleSearchParamsInput): input is { get(name: string): string | null; toString(): string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "get" in input &&
    typeof input.get === "function" &&
    "toString" in input &&
    typeof input.toString === "function"
  );
}
