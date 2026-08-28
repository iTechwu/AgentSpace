"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  scopeWorkspaceModuleCacheKey,
  useWorkspaceModuleCache,
  useWorkspaceModuleCacheScope,
} from "@/features/dashboard/workspace-module-cache";
import type { WorkspaceModuleLoaderData } from "@/features/dashboard/workspace-module-loaders";
import {
  recordWorkspaceInitialModuleClientRender,
  recordWorkspaceInitialModulePayload,
} from "@/features/dashboard/workspace-navigation-performance";
import {
  buildWorkspaceModuleDataQuery,
  normalizeWorkspaceModuleQuery,
  parseWorkspaceModulePath,
} from "@/features/dashboard/workspace-module-route";

export function WorkspaceInitialModuleData({
  children,
  moduleData,
  serverDurationMs,
  workspaceId,
}: {
  children: React.ReactNode;
  moduleData: WorkspaceModuleLoaderData;
  serverDurationMs?: number;
  workspaceId: string;
}) {
  const { set } = useWorkspaceModuleCache();
  const cacheScope = useWorkspaceModuleCacheScope();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const seedQueryRef = useRef<{
    moduleData: WorkspaceModuleLoaderData;
    queryKey: string;
  } | null>(null);
  if (seedQueryRef.current?.moduleData !== moduleData) {
    seedQueryRef.current = {
      moduleData,
      queryKey: resolveInitialModuleDataQueryKey({
        moduleData,
        pathname,
        searchKey,
      }),
    };
  }
  const queryKey = seedQueryRef.current.queryKey;
  const scopedCacheKey = useMemo(
    () => scopeWorkspaceModuleCacheKey({ workspaceId, moduleId: moduleData.moduleId, queryKey }, cacheScope),
    [cacheScope, moduleData.moduleId, queryKey, workspaceId],
  );

  useEffect(() => {
    set(scopedCacheKey, moduleData);
    recordWorkspaceInitialModulePayload({
      moduleData,
      moduleId: moduleData.moduleId,
      queryKey,
      serverDurationMs,
      workspaceId,
    });
    recordWorkspaceInitialModuleClientRender({
      moduleId: moduleData.moduleId,
      queryKey,
      workspaceId,
    });
  }, [moduleData, queryKey, scopedCacheKey, serverDurationMs, set, workspaceId]);

  return <>{children}</>;
}

function resolveInitialModuleDataQueryKey({
  moduleData,
  pathname,
  searchKey,
}: {
  moduleData: WorkspaceModuleLoaderData;
  pathname: string;
  searchKey: string;
}): string {
  if (moduleData.moduleId === "settings") {
    const params = normalizeWorkspaceModuleQuery(moduleData.moduleId, searchKey);
    params.set("section", moduleData.data.initialSection);
    return normalizeWorkspaceModuleQuery(moduleData.moduleId, params).toString();
  }

  const routeState = parseWorkspaceModulePath(pathname, searchKey);
  if (routeState.moduleId === moduleData.moduleId) {
    return buildWorkspaceModuleDataQuery(routeState).toString();
  }
  return normalizeWorkspaceModuleQuery(moduleData.moduleId, searchKey).toString();
}
