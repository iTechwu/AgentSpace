"use client";

import { createContext, useContext } from "react";

type WorkspaceModuleNavigationContextValue = {
  navigateWorkspaceModule: (href: string, options?: { replace?: boolean }) => boolean;
};

const WorkspaceModuleNavigationContext = createContext<WorkspaceModuleNavigationContextValue | null>(null);

export function WorkspaceModuleNavigationProvider({
  children,
  navigateWorkspaceModule,
}: {
  children: React.ReactNode;
  navigateWorkspaceModule: (href: string, options?: { replace?: boolean }) => boolean;
}) {
  return (
    <WorkspaceModuleNavigationContext.Provider value={{ navigateWorkspaceModule }}>
      {children}
    </WorkspaceModuleNavigationContext.Provider>
  );
}

export function useWorkspaceModuleNavigation(): WorkspaceModuleNavigationContextValue {
  return useContext(WorkspaceModuleNavigationContext) ?? {
    navigateWorkspaceModule: () => false,
  };
}
