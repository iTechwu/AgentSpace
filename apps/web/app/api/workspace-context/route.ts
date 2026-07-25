import {
  listWorkspaceContextChannelsSync,
  listWorkspaceContextDocumentsSync,
  listWorkspaceContextEntitiesSync,
  resolveWorkspaceContextEntitySync,
  searchWorkspaceContextMessagesSync,
} from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkspaceContextAction =
  | "list_entities"
  | "resolve_entity"
  | "list_channels"
  | "search_messages"
  | "list_documents";

export async function GET(request: Request): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!hasWorkspaceRole(workspaceContext.currentMembership.role, "admin")) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const agent = url.searchParams.get("agent")?.trim() ?? "";
  const query = url.searchParams.get("query")?.trim() ?? "";
  const channel = url.searchParams.get("channel")?.trim() ?? undefined;

  if (!isWorkspaceContextAction(action)) {
    return Response.json(
      {
        error:
          "Unsupported workspace context action. Expected one of: list_entities, resolve_entity, list_channels, search_messages, list_documents.",
      },
      { status: 400 },
    );
  }

  if (!agent) {
    return Response.json({ error: "Query parameter `agent` is required." }, { status: 400 });
  }

  if ((action === "resolve_entity" || action === "search_messages") && !query) {
    return Response.json({ error: "Query parameter `query` is required for this action." }, { status: 400 });
  }

  const payload = await readLoadtestWorkspaceContextCache(
    [
      workspaceContext.currentWorkspace.id,
      workspaceContext.currentUser.id,
      workspaceContext.currentMembership.role,
      action,
      agent,
      query,
      channel ?? "",
    ].join("\u001f"),
    () => resolveWorkspaceContextPayload({
      action,
      agent,
      channel,
      query,
      workspaceId: workspaceContext.currentWorkspace.id,
    }),
  );
  return Response.json(payload);
}

function resolveWorkspaceContextPayload(input: {
  action: WorkspaceContextAction;
  agent: string;
  channel?: string;
  query: string;
  workspaceId: string;
}): Record<string, unknown> {
  switch (input.action) {
    case "list_entities":
      return {
        action: input.action,
        entities: listWorkspaceContextEntitiesSync(input.agent, input.workspaceId),
      };
    case "resolve_entity":
      return {
        action: input.action,
        entity: resolveWorkspaceContextEntitySync(input.agent, input.query, input.workspaceId) ?? null,
      };
    case "list_channels":
      return {
        action: input.action,
        channels: listWorkspaceContextChannelsSync(input.agent, input.workspaceId),
      };
    case "search_messages":
      return {
        action: input.action,
        messages: searchWorkspaceContextMessagesSync(input.agent, input.query, input.channel, input.workspaceId),
      };
    case "list_documents":
      return {
        action: input.action,
        documents: listWorkspaceContextDocumentsSync(input.agent, input.channel, input.workspaceId).map((document) => ({
          id: document.id,
          channelName: document.channelName,
          title: document.title,
          summary: document.summary,
          currentVersionId: document.currentVersionId,
          updatedBy: document.updatedBy,
          updatedAt: document.updatedAt,
        })),
      };
  }
}

type WorkspaceContextCacheEntry = {
  expiresAt: number;
  promise?: Promise<Record<string, unknown>>;
  value?: Record<string, unknown>;
};

const workspaceContextCacheGlobal = globalThis as typeof globalThis & {
  __dofeAgentLoadtestWorkspaceContextCache?: Map<string, WorkspaceContextCacheEntry>;
};

const loadtestWorkspaceContextCache = workspaceContextCacheGlobal.__dofeAgentLoadtestWorkspaceContextCache
  ?? new Map<string, WorkspaceContextCacheEntry>();
workspaceContextCacheGlobal.__dofeAgentLoadtestWorkspaceContextCache = loadtestWorkspaceContextCache;

function readLoadtestWorkspaceContextCache(
  key: string,
  loader: () => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ttlMs = getLoadtestWorkspaceContextCacheTtlMs();
  if (ttlMs <= 0) {
    return Promise.resolve(loader());
  }

  const now = Date.now();
  const existing = loadtestWorkspaceContextCache.get(key);
  if (existing && existing.expiresAt > now) {
    if (existing.value) {
      return Promise.resolve(existing.value);
    }
    if (existing.promise) {
      return existing.promise;
    }
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      loadtestWorkspaceContextCache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      pruneLoadtestWorkspaceContextCache();
      return value;
    })
    .catch((error) => {
      const current = loadtestWorkspaceContextCache.get(key);
      if (current?.promise === promise) {
        loadtestWorkspaceContextCache.delete(key);
      }
      throw error;
    });

  loadtestWorkspaceContextCache.set(key, {
    expiresAt: now + ttlMs,
    promise,
  });
  return promise;
}

function getLoadtestWorkspaceContextCacheTtlMs(): number {
  const explicit = Number(process.env.DOFE_AGENT_WORKSPACE_CONTEXT_CACHE_TTL_MS ?? "");
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return process.env.LOADTEST_MODE === "local" ? 30_000 : 0;
}

function pruneLoadtestWorkspaceContextCache(): void {
  if (loadtestWorkspaceContextCache.size <= 200) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of loadtestWorkspaceContextCache) {
    if (entry.expiresAt <= now) {
      loadtestWorkspaceContextCache.delete(key);
    }
  }
}

function isWorkspaceContextAction(value: string | null): value is WorkspaceContextAction {
  return value === "list_entities"
    || value === "resolve_entity"
    || value === "list_channels"
    || value === "search_messages"
    || value === "list_documents";
}
