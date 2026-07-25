"use client";

import type { WorkspaceModuleRouteState } from "@/features/dashboard/workspace-module-route";

const WORKSPACE_NAVIGATION_MARK_PREFIX = "dofe-agent.workspace.navigation";
const WORKSPACE_SHELL_COUNTERS_MARK_PREFIX = "dofe-agent.workspace.shell-counters";

const shellCountersRefreshState = new Map<string, {
  count: number;
  lastMarkName?: string;
}>();

export function recordWorkspaceInitialModulePayload(input: {
  moduleData: unknown;
  moduleId: string;
  queryKey: string;
  serverDurationMs?: number;
  workspaceId: string;
}): void {
  if (!isWorkspaceNavigationDebugEnabled()) {
    return;
  }

  const seedBytes = measureJsonByteLength(input.moduleData);
  const rscEntry = findLatestWorkspaceRscResourceEntry();
  const navigationEntry = findLatestNavigationEntry();
  const parts = [
    `[workspace:initial] ${input.moduleId}`,
    `workspace ${input.workspaceId}`,
    input.queryKey ? `query ${input.queryKey}` : "query default",
    seedBytes === undefined ? "seed unavailable" : `seed ${seedBytes} bytes`,
  ];
  if (typeof input.serverDurationMs === "number") {
    parts.push(`server ${Math.round(input.serverDurationMs)}ms`);
  }

  if (rscEntry) {
    parts.push(`rsc ${formatPayloadPerformanceEntry(rscEntry)}`);
  }

  if (navigationEntry) {
    parts.push(`route ${formatPayloadPerformanceEntry(navigationEntry)}`);
  }

  console.debug(parts.join("; "));
}

export function recordWorkspaceInitialModuleClientRender(input: {
  moduleId: string;
  queryKey: string;
  workspaceId: string;
}): void {
  if (!isWorkspaceNavigationDebugEnabled()) {
    return;
  }

  window.requestAnimationFrame(() => {
    const navigationEntry = findLatestNavigationEntry();
    const renderMs = navigationEntry ? measureElapsedSinceEntryStart(navigationEntry) : undefined;
    console.debug([
      `[workspace:initial-render] ${input.moduleId}`,
      `workspace ${input.workspaceId}`,
      input.queryKey ? `query ${input.queryKey}` : "query default",
      renderMs === undefined ? "client render unavailable" : `client render ${Math.round(renderMs)}ms`,
    ].join("; "));
  });
}

export function recordWorkspaceModuleRouterRefreshFallback(reason: string): void {
  if (!isWorkspaceNavigationDebugEnabled()) {
    return;
  }

  console.debug(`[workspace:refresh] router.refresh fallback; reason ${reason}`);
}

export function markWorkspaceModuleNavigationClick(routeState: WorkspaceModuleRouteState): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  const moduleLabel = routeState.moduleId ?? "unknown";
  window.performance.mark(`${WORKSPACE_NAVIGATION_MARK_PREFIX}.click`);
  window.performance.mark(`${WORKSPACE_NAVIGATION_MARK_PREFIX}.${moduleLabel}.click`);
}

export function measureWorkspaceModuleNavigationActive(routeState: WorkspaceModuleRouteState): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  measureWorkspaceModuleNavigation("click-to-active", routeState);
}

export function measureWorkspaceModuleNavigationSettled(routeState: WorkspaceModuleRouteState): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  window.requestAnimationFrame(() => {
    measureWorkspaceModuleNavigation("click-to-settled", routeState);
  });
}

export function measureWorkspaceModuleNavigationCacheHit(routeState: WorkspaceModuleRouteState): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  window.requestAnimationFrame(() => {
    measureWorkspaceModuleNavigation("click-to-cached-content", routeState);
  });
}

export function measureWorkspaceModuleNavigationFirstLoad(routeState: WorkspaceModuleRouteState): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  window.requestAnimationFrame(() => {
    measureWorkspaceModuleNavigation("click-to-first-load", routeState);
  });
}

export function recordWorkspaceShellCountersRefresh(workspaceSlug: string): void {
  if (!isWorkspaceNavigationPerformanceEnabled()) {
    return;
  }

  const workspaceLabel = workspaceSlug || "unknown";
  const previousState = shellCountersRefreshState.get(workspaceLabel) ?? { count: 0 };
  const count = previousState.count + 1;
  const currentMarkName = `${WORKSPACE_SHELL_COUNTERS_MARK_PREFIX}.${workspaceLabel}.refresh.${count}`;
  const measureName = `${WORKSPACE_SHELL_COUNTERS_MARK_PREFIX}.${workspaceLabel}.refresh-interval`;

  window.performance.mark(currentMarkName);

  let intervalMs: number | undefined;
  if (previousState.lastMarkName) {
    try {
      window.performance.measure(measureName, previousState.lastMarkName, currentMarkName);
      intervalMs = window.performance.getEntriesByName(measureName).at(-1)?.duration;
    } catch {
      intervalMs = undefined;
    }
    window.performance.clearMarks(previousState.lastMarkName);
    window.performance.clearMeasures(measureName);
  }

  shellCountersRefreshState.set(workspaceLabel, {
    count,
    lastMarkName: currentMarkName,
  });

  console.debug(
    intervalMs === undefined
      ? `[workspace:shell-counters] ${workspaceLabel} refresh #${count}`
      : `[workspace:shell-counters] ${workspaceLabel} refresh #${count} interval ${Math.round(intervalMs)}ms`,
  );
}

function measureWorkspaceModuleNavigation(name: string, routeState: WorkspaceModuleRouteState): void {
  const moduleLabel = routeState.moduleId ?? "unknown";
  const startMark = `${WORKSPACE_NAVIGATION_MARK_PREFIX}.${moduleLabel}.click`;
  const fallbackStartMark = `${WORKSPACE_NAVIGATION_MARK_PREFIX}.click`;
  const endMark = `${WORKSPACE_NAVIGATION_MARK_PREFIX}.${moduleLabel}.${name}.end`;
  const measureName = `${WORKSPACE_NAVIGATION_MARK_PREFIX}.${moduleLabel}.${name}`;

  window.performance.mark(endMark);
  try {
    window.performance.measure(measureName, startMark, endMark);
  } catch {
    try {
      window.performance.measure(measureName, fallbackStartMark, endMark);
    } catch {
      return;
    }
  }

  const measure = window.performance.getEntriesByName(measureName).at(-1);
  if (measure) {
    console.debug(`[workspace:nav] ${moduleLabel} ${name} ${Math.round(measure.duration)}ms`);
  }
  window.performance.clearMarks(endMark);
  window.performance.clearMeasures(measureName);
}

function measureJsonByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      return undefined;
    }
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(json).length;
    }
    return json.length;
  } catch {
    return undefined;
  }
}

function findLatestWorkspaceRscResourceEntry(): PerformanceEntry | undefined {
  return getPerformanceEntries("resource")
    .filter((entry) => entry.name.includes("_rsc="))
    .at(-1);
}

function findLatestNavigationEntry(): PerformanceEntry | undefined {
  return getPerformanceEntries("navigation").at(-1);
}

function getPerformanceEntries(type: string): PerformanceEntry[] {
  const getEntriesByType = window.performance?.getEntriesByType;
  if (typeof getEntriesByType !== "function") {
    return [];
  }
  return getEntriesByType.call(window.performance, type);
}

function formatPayloadPerformanceEntry(entry: PerformanceEntry): string {
  return [
    formatPayloadSizeMetric(entry, "transferSize", "transfer"),
    formatPayloadSizeMetric(entry, "encodedBodySize", "encoded"),
    formatPayloadSizeMetric(entry, "decodedBodySize", "decoded"),
    formatPayloadDurationMetric(entry),
  ].filter(Boolean).join(" ");
}

function formatPayloadSizeMetric(entry: PerformanceEntry, key: string, label: string): string | null {
  const value = readFiniteNumber(entry, key);
  return value === undefined ? null : `${label} ${Math.round(value)} bytes`;
}

function formatPayloadDurationMetric(entry: PerformanceEntry): string | null {
  const duration = readFiniteNumber(entry, "duration");
  if (duration !== undefined && duration > 0) {
    return `duration ${Math.round(duration)}ms`;
  }

  const requestStart = readFiniteNumber(entry, "requestStart") ?? readFiniteNumber(entry, "startTime") ?? 0;
  const responseEnd = readFiniteNumber(entry, "responseEnd");
  if (responseEnd === undefined) {
    return null;
  }
  return `duration ${Math.round(Math.max(responseEnd - requestStart, 0))}ms`;
}

function measureElapsedSinceEntryStart(entry: PerformanceEntry): number | undefined {
  const now = typeof window.performance?.now === "function" ? window.performance.now() : undefined;
  if (now === undefined) {
    return undefined;
  }
  return Math.max(now - entry.startTime, 0);
}

function readFiniteNumber(entry: PerformanceEntry, key: string): number | undefined {
  const value = (entry as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isWorkspaceNavigationDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    typeof window.performance !== "undefined"
  );
}

function isWorkspaceNavigationPerformanceEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    typeof window.performance?.mark === "function" &&
    typeof window.performance?.measure === "function"
  );
}
