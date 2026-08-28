"use client";

import { recordWorkspaceModuleRouterRefreshFallback } from "@/features/dashboard/workspace-navigation-performance";

interface RefreshRouter {
  refresh(): void;
}

export function refreshWorkspaceModule(onDataChanged: (() => void) | undefined, router: RefreshRouter): void {
  if (onDataChanged) {
    onDataChanged();
    return;
  }

  recordWorkspaceModuleRouterRefreshFallback("missing module data callback");
  router.refresh();
}
