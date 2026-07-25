"use server";

import {
  createDataTableSync,
  updateDataTableSync,
  deleteDataTableSync,
  addDataRowSync,
  updateDataRowSync,
  deleteDataRowSync,
} from "@dofe-agent/services";
import type { DataColumn } from "@dofe-agent/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath } from "@/features/auth/workspace-revalidation";

export async function createDataTableAction(input: {
  name: string;
  channelName?: string;
  columns: Array<{
    name: string;
    type: DataColumn["type"];
    options?: string[];
    required?: boolean;
  }>;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createDataTableSync(input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}

export async function updateDataTableAction(
  id: string,
  input: {
    name?: string;
    channelName?: string;
    columns?: Array<{
      id?: string;
      name: string;
      type: DataColumn["type"];
      options?: string[];
      required?: boolean;
    }>;
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateDataTableSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}

export async function deleteDataTableAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteDataTableSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}

export async function addDataRowAction(
  tableId: string,
  cells: Record<string, unknown>,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  addDataRowSync(tableId, { cells }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}

export async function updateDataRowAction(
  tableId: string,
  rowId: string,
  cells: Record<string, unknown>,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  updateDataRowSync(tableId, rowId, cells, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}

export async function deleteDataRowAction(
  tableId: string,
  rowId: string,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  deleteDataRowSync(tableId, rowId, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/tables", workspaceContext.currentWorkspace.slug);
}
