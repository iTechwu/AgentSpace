import { NextResponse, type NextRequest } from "next/server";
import type { WorkspaceRole } from "@dofe-agent/db";
import {
  canViewChannelDocumentSync,
  globalSearchSync,
  type SearchResult,
  type SearchResultType,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { getKnowledgePageData } from "@/features/dashboard/data";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import {
  filterSearchResultsByChannelVisibility,
  getWorkspaceChannelVisibilitySync,
} from "@/features/auth/workspace-channel-visibility";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get("q") ?? "";
  const typesRaw = request.nextUrl.searchParams.get("types");
  const channel = request.nextUrl.searchParams.get("channel") ?? undefined;
  const assignedAgentName = request.nextUrl.searchParams.get("agent")?.trim() || undefined;
  const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim() || undefined;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "30");

  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceContext.currentWorkspace.id) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: "Cross-workspace search access denied",
      note:
        `Search request asked for workspace "${requestedWorkspaceId}" while the current workspace `
        + `is "${workspaceContext.currentWorkspace.id}".`,
      code: "workspace.cross_workspace_access_denied",
      data: {
        actorType: "session_user",
        resourceType: "search",
        requestedWorkspaceId,
      },
    });
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const types = typesRaw
    ? (typesRaw.split(",").filter(Boolean) as SearchResultType[])
    : undefined;
  const results = await readLoadtestSearchResultsCache(
    [
      workspaceContext.currentWorkspace.id,
      workspaceContext.currentUser.id,
      workspaceContext.currentUser.displayName,
      workspaceContext.currentMembership.role,
      query,
      typesRaw ?? "",
      channel ?? "",
      assignedAgentName ?? "",
      String(limit),
    ].join("\u001f"),
    () => resolveSearchResults({
      assignedAgentName,
      channel,
      currentUserDisplayName: workspaceContext.currentUser.displayName,
      currentUserId: workspaceContext.currentUser.id,
      currentUserRole: workspaceContext.currentMembership.role,
      query,
      limit,
      types,
      workspaceId: workspaceContext.currentWorkspace.id,
    }),
  );

  return NextResponse.json({ results });
}

function resolveSearchResults(input: {
  assignedAgentName?: string;
  channel?: string;
  currentUserDisplayName: string;
  currentUserId: string;
  currentUserRole: WorkspaceRole;
  query: string;
  limit: number;
  types?: SearchResultType[];
  workspaceId: string;
}): SearchResult[] {
  const visibility = getWorkspaceChannelVisibilitySync(
    input.workspaceId,
    input.currentUserDisplayName,
    {
      userId: input.currentUserId,
      role: input.currentUserRole,
    },
  );
  if (input.channel && !visibility.canAccessChannel(input.channel)) {
    return [];
  }

  const requestedLimit = Math.min(input.limit, 100);
  const documentRequested = !input.types || input.types.includes("document");
  const nonDocumentTypes = input.types
    ? input.types.filter((type) => type !== "document")
    : ["message", "task", "agent", "skill", "knowledge"] satisfies SearchResultType[];

  const baseResults = filterSearchResultsByChannelVisibility(globalSearchSync(input.query, {
    types: nonDocumentTypes,
    channelName: input.channel,
    assignedAgentName: input.assignedAgentName,
    limit: 100,
    workspaceId: input.workspaceId,
  }), visibility);

  const documentResults = documentRequested
    ? searchKnowledgeDocumentPages(input.query, {
        channelName: input.channel,
        currentUserDisplayName: input.currentUserDisplayName,
        workspaceId: input.workspaceId,
      })
    : [];

  return [...baseResults, ...documentResults]
    .filter((result) => (
      result.type !== "document"
      || result.meta?.sourceType !== "channelDocument"
      || canViewChannelDocumentSync(
        result.id,
        input.currentUserDisplayName,
        "human",
        input.workspaceId,
      )
    ))
    .sort((left, right) => right.score - left.score)
    .slice(0, requestedLimit);
}

function searchKnowledgeDocumentPages(
  query: string,
  input: {
    channelName?: string;
    currentUserDisplayName: string;
    workspaceId: string;
  },
): SearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const lowerQuery = trimmed.toLocaleLowerCase("zh-CN");
  const tokens = lowerQuery.split(/\s+/).filter(Boolean);
  const knowledgeData = getKnowledgePageData(input.currentUserDisplayName, input.workspaceId);

  return knowledgeData.documentPages
    .filter((document) => !input.channelName || document.channelName === input.channelName)
    .filter((document) => {
      const haystack = [
        document.title,
        document.summary,
        document.previewText,
        document.fileName,
        document.channelName,
        document.sourceSpeaker,
        document.mediaType,
        ...document.linkedKnowledgePages.map((page) => page.title),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return tokens.every((token) => haystack.includes(token));
    })
    .slice(0, 40)
    .map((document) => ({
      type: "document" as const,
      id: document.sourceId,
      title: document.title,
      snippet: document.previewText || document.summary || document.fileName,
      score: computeScore(`${document.title} ${document.fileName}`, tokens) + 0.5,
      meta: {
        channel: document.channelName ?? "",
        documentKey: document.id,
        sourceType: document.sourceType,
        view: "documents",
        updatedAt: document.updatedAt,
      },
    }));
}

function computeScore(text: string, tokens: string[]): number {
  const lower = text.toLocaleLowerCase("zh-CN");
  let score = 0;
  for (const token of tokens) {
    if (lower.startsWith(token)) {
      score += 3;
    } else if (lower.includes(token)) {
      score += 1;
    }
  }
  return score / Math.max(tokens.length, 1);
}

type SearchResultsCacheEntry = {
  expiresAt: number;
  promise?: Promise<SearchResult[]>;
  value?: SearchResult[];
};

const searchCacheGlobal = globalThis as typeof globalThis & {
  __dofeAgentLoadtestSearchResultsCache?: Map<string, SearchResultsCacheEntry>;
};

const loadtestSearchResultsCache = searchCacheGlobal.__dofeAgentLoadtestSearchResultsCache
  ?? new Map<string, SearchResultsCacheEntry>();
searchCacheGlobal.__dofeAgentLoadtestSearchResultsCache = loadtestSearchResultsCache;

function readLoadtestSearchResultsCache(
  key: string,
  loader: () => SearchResult[],
): Promise<SearchResult[]> {
  const ttlMs = getLoadtestSearchCacheTtlMs();
  if (ttlMs <= 0) {
    return Promise.resolve(loader());
  }

  const now = Date.now();
  const existing = loadtestSearchResultsCache.get(key);
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
      loadtestSearchResultsCache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      pruneLoadtestSearchResultsCache();
      return value;
    })
    .catch((error) => {
      const current = loadtestSearchResultsCache.get(key);
      if (current?.promise === promise) {
        loadtestSearchResultsCache.delete(key);
      }
      throw error;
    });

  loadtestSearchResultsCache.set(key, {
    expiresAt: now + ttlMs,
    promise,
  });
  return promise;
}

function getLoadtestSearchCacheTtlMs(): number {
  const explicit = Number(process.env.DOFE_AGENT_SEARCH_CACHE_TTL_MS ?? "");
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return process.env.LOADTEST_MODE === "local" ? 30_000 : 0;
}

function pruneLoadtestSearchResultsCache(): void {
  if (loadtestSearchResultsCache.size <= 200) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of loadtestSearchResultsCache) {
    if (entry.expiresAt <= now) {
      loadtestSearchResultsCache.delete(key);
    }
  }
}
