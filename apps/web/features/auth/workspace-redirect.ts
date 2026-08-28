"use server";

import { redirect } from "next/navigation";
import { getCurrentWorkspaceContext } from "./server-workspace";
import { buildWorkspacePath } from "./workspace-paths";

type SearchParamsValue = string | string[] | undefined;
type SearchParamsRecord = Record<string, SearchParamsValue>;

export async function redirectToCurrentWorkspacePath(
  pathname: string,
  searchParams?: Promise<SearchParamsRecord> | SearchParamsRecord,
): Promise<never> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    redirect("/");
  }

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  redirect(
    buildWorkspacePath(
      workspaceContext.currentWorkspace.id,
      appendSearchParams(pathname, resolvedSearchParams),
    ),
  );
}

function appendSearchParams(pathname: string, searchParams?: SearchParamsRecord): string {
  if (!searchParams) {
    return pathname;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.length > 0) {
          params.append(key, item);
        }
      }
    }
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
