"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export const SIDEBAR_VISIBILITY_STORAGE_KEY = "dofe-agent-sidebar-visibility";
export const SIDEBAR_VISIBILITY_STORAGE_VERSION = 2;

export const SIDEBAR_SECTION_IDS = [
  "messages",
  "approvals",
  "taskBoard",
  "channels",
  "contacts",
  "employeeManagement",
  "skills",
  "market",
  "containers",
  "knowledge",
  "performance",
  "orgChart",
  "costs",
  "tables",
  "automations",
  "calendar",
  "templates",
] as const;

export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

export type SidebarVisibilityState = Record<SidebarSectionId, boolean>;

export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibilityState = {
  messages: true,
  approvals: false,
  taskBoard: false,
  channels: true,
  contacts: true,
  employeeManagement: true,
  skills: true,
  market: true,
  containers: true,
  knowledge: true,
  performance: false,
  orgChart: false,
  costs: false,
  tables: false,
  automations: false,
  calendar: false,
  templates: false,
};

type SidebarVisibilityContextValue = {
  visibility: SidebarVisibilityState;
  setSectionVisibility: (sectionId: SidebarSectionId, visible: boolean) => void;
};

const SidebarVisibilityContext = createContext<SidebarVisibilityContextValue | null>(null);

function sanitizeSidebarVisibility(value: unknown): SidebarVisibilityState {
  const nextVisibility = { ...DEFAULT_SIDEBAR_VISIBILITY };
  if (!value || typeof value !== "object") {
    return nextVisibility;
  }

  const record = value as Record<string, unknown>;
  const storedVersion = record.__version;
  if (storedVersion !== SIDEBAR_VISIBILITY_STORAGE_VERSION) {
    for (const sectionId of SIDEBAR_SECTION_IDS) {
      if (DEFAULT_SIDEBAR_VISIBILITY[sectionId] && typeof record[sectionId] === "boolean") {
        nextVisibility[sectionId] = record[sectionId];
      }
    }
    return nextVisibility;
  }

  for (const sectionId of SIDEBAR_SECTION_IDS) {
    if (typeof record[sectionId] === "boolean") {
      nextVisibility[sectionId] = record[sectionId];
    }
  }

  return nextVisibility;
}

export function SidebarVisibilityProvider({ children }: { children: React.ReactNode }) {
  const [visibility, setVisibility] = useState<SidebarVisibilityState>(DEFAULT_SIDEBAR_VISIBILITY);
  const [hasLoadedStoredValue, setHasLoadedStoredValue] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY);
      if (stored) {
        setVisibility(sanitizeSidebarVisibility(JSON.parse(stored)));
      }
    } catch {
      setVisibility(DEFAULT_SIDEBAR_VISIBILITY);
    } finally {
      setHasLoadedStoredValue(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedStoredValue) {
      return;
    }
    window.localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, JSON.stringify({
      ...visibility,
      __version: SIDEBAR_VISIBILITY_STORAGE_VERSION,
    }));
  }, [hasLoadedStoredValue, visibility]);

  const value = useMemo<SidebarVisibilityContextValue>(
    () => ({
      visibility,
      setSectionVisibility: (sectionId, visible) => {
        setVisibility((current) => ({
          ...current,
          [sectionId]: visible,
        }));
      },
    }),
    [visibility],
  );

  return <SidebarVisibilityContext.Provider value={value}>{children}</SidebarVisibilityContext.Provider>;
}

export function useSidebarVisibility(): SidebarVisibilityContextValue {
  const context = useContext(SidebarVisibilityContext);
  if (!context) {
    throw new Error("useSidebarVisibility must be used within SidebarVisibilityProvider.");
  }
  return context;
}
