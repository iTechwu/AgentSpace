import type {
  DofeAgentState,
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
} from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { createOpaqueId } from "../shared/helpers.ts";
import { assertTriggerWriteOwnerSync } from "../workflows/feature-flags.ts";

export function listAutomationRulesSync(workspaceId?: string): AutomationRule[] {
  const state = ensureWorkspaceStateSync(workspaceId);
  return state.automationRules ?? [];
}

export function readAutomationRuleSync(id: string, workspaceId?: string): AutomationRule | undefined {
  const state = ensureWorkspaceStateSync(workspaceId);
  return (state.automationRules ?? []).find((rule) => rule.id === id);
}

export function createAutomationRuleSync(input: {
  name: string;
  description?: string;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
  createdBy?: string;
}, workspaceId?: string): DofeAgentState {
  assertTriggerWriteOwnerSync(workspaceId ?? "default", "automations");
  const state = ensureWorkspaceStateSync(workspaceId);
  const name = input.name.trim();
  if (!name) {
    throw new Error("Automation rule name is required.");
  }
  if (input.actions.length === 0) {
    throw new Error("At least one action is required.");
  }

  const now = new Date().toISOString();
  const rule: AutomationRule = {
    id: createOpaqueId(),
    name,
    description: input.description?.trim() ?? "",
    enabled: true,
    trigger: input.trigger,
    conditions: input.conditions ?? [],
    actions: input.actions,
    runCount: 0,
    createdBy: input.createdBy ?? "",
    createdAt: now,
    updatedAt: now,
  };

  if (!state.automationRules) {
    state.automationRules = [];
  }
  state.automationRules.push(rule);
  state.ledger.unshift({
    title: "Automation rule created",
    note: `Created automation "${name}" with trigger "${input.trigger.type}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateAutomationRuleSync(
  id: string,
  input: {
    name?: string;
    description?: string;
    trigger?: AutomationTrigger;
    conditions?: AutomationCondition[];
    actions?: AutomationAction[];
  },
  workspaceId?: string,
): DofeAgentState {
  assertTriggerWriteOwnerSync(workspaceId ?? "default", "automations");
  const state = ensureWorkspaceStateSync(workspaceId);
  const rule = (state.automationRules ?? []).find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Automation rule "${id}" does not exist.`);
  }

  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new Error("Automation rule name is required.");
    }
    rule.name = trimmed;
  }

  if (typeof input.description === "string") {
    rule.description = input.description.trim();
  }

  if (input.trigger) {
    rule.trigger = input.trigger;
  }

  if (Array.isArray(input.conditions)) {
    rule.conditions = input.conditions;
  }

  if (Array.isArray(input.actions)) {
    if (input.actions.length === 0) {
      throw new Error("At least one action is required.");
    }
    rule.actions = input.actions;
  }

  rule.updatedAt = new Date().toISOString();

  state.ledger.unshift({
    title: "Automation rule updated",
    note: `Updated automation "${rule.name}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function toggleAutomationRuleSync(id: string, enabled: boolean, workspaceId?: string): DofeAgentState {
  assertTriggerWriteOwnerSync(workspaceId ?? "default", "automations");
  const state = ensureWorkspaceStateSync(workspaceId);
  const rule = (state.automationRules ?? []).find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Automation rule "${id}" does not exist.`);
  }

  rule.enabled = enabled;
  rule.updatedAt = new Date().toISOString();

  return writeWorkspaceStateSync(state, workspaceId);
}

export function deleteAutomationRuleSync(id: string, workspaceId?: string): DofeAgentState {
  assertTriggerWriteOwnerSync(workspaceId ?? "default", "automations");
  const state = ensureWorkspaceStateSync(workspaceId);
  const rule = (state.automationRules ?? []).find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Automation rule "${id}" does not exist.`);
  }

  state.automationRules = (state.automationRules ?? []).filter((r) => r.id !== id);

  state.ledger.unshift({
    title: "Automation rule deleted",
    note: `Deleted automation "${rule.name}".`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}
