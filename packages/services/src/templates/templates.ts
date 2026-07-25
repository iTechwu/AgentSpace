import type { DofeAgentState, Template } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { createOpaqueId } from "../shared/helpers.ts";

export function listTemplatesSync(workspaceId?: string): Template[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  return state.templates ?? [];
}

export function readTemplateSync(id: string, workspaceId?: string): Template | undefined {
  const state = ensureWorkspaceStateSync(workspaceId);
  return (state.templates ?? []).find((template) => template.id === id);
}

export function createTemplateSync(input: {
  category: Template["category"];
  name: string;
  description?: string;
  configJson: string;
  createdBy?: string;
}, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const name = input.name.trim();
  if (!name) {
    throw new Error("Template name is required.");
  }

  const now = new Date().toISOString();
  const template: Template = {
    id: createOpaqueId(),
    category: input.category,
    name,
    description: input.description?.trim() ?? "",
    configJson: input.configJson,
    builtIn: false,
    createdBy: input.createdBy ?? "",
    createdAt: now,
    updatedAt: now,
  };

  if (!state.templates) {
    state.templates = [];
  }
  state.templates.push(template);
  state.ledger.unshift({
    title: "Template created",
    note: `Created ${input.category} template "${name}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateTemplateSync(
  id: string,
  input: {
    name?: string;
    description?: string;
    configJson?: string;
  },
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const template = (state.templates ?? []).find((t) => t.id === id);
  if (!template) {
    throw new Error(`Template "${id}" does not exist.`);
  }
  if (template.builtIn) {
    throw new Error("Built-in templates cannot be modified.");
  }

  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new Error("Template name is required.");
    }
    template.name = trimmed;
  }

  if (typeof input.description === "string") {
    template.description = input.description.trim();
  }

  if (typeof input.configJson === "string") {
    template.configJson = input.configJson;
  }

  template.updatedAt = new Date().toISOString();

  state.ledger.unshift({
    title: "Template updated",
    note: `Updated template "${template.name}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function deleteTemplateSync(id: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const template = (state.templates ?? []).find((t) => t.id === id);
  if (!template) {
    throw new Error(`Template "${id}" does not exist.`);
  }
  if (template.builtIn) {
    throw new Error("Built-in templates cannot be deleted.");
  }

  state.templates = (state.templates ?? []).filter((t) => t.id !== id);

  state.ledger.unshift({
    title: "Template deleted",
    note: `Deleted template "${template.name}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}
