import {
  bindEmployeeRuntimeSync as bindEmployeeRuntimeRecordSync,
  DEFAULT_WORKSPACE_ID,
  createStoredEmployeeSync,
  deleteStoredEmployeeSync,
  deleteStoredTasksForAssigneeSync,
  deleteStoredKnowledgeAssignmentsForEmployeeSync,
  deleteEmployeeExecutionStateSync,
  listStoredAgentSkillAssignmentsSync,
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  readAgentRuntimeSync,
  readEmployeeRuntimeBindingSync,
  replaceStoredChannelsSync,
  setStoredEmployeeSkillAssignmentsSync,
  unbindEmployeeRuntimeSync as unbindEmployeeRuntimeRecordSync,
  updateStoredEmployeeSync,
  withTransaction,
  writeWorkspaceStateRecordSync,
} from "@dofe-agent/db";
import {
  type AgentChannelMemberAccess,
  type ActiveEmployee,
  type DofeAgentState,
  type EmployeeExecutionPolicy,
} from "@dofe-agent/domain/workspace";
import { deleteUnreferencedWorkspaceAttachmentsSync } from "../attachments/attachments.ts";
import { isDirectChannel, removeChannelArtifactsFromState } from "../channels/channels.ts";
import { listWorkspaceSkillsSync } from "../skills/skills.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, normalizeSkillIds, uniqueStringValues } from "../shared/helpers.ts";
import { normalizeWorkspaceState } from "../shared/normalizers.ts";
import { pushWorkspaceMessageIfChannel } from "../shared/messaging.ts";
import { resolveAgentRuntimeMode } from "../config/deployment.ts";
import {
  assertCanManageEmployeeForActorSync,
  assertCanUseRuntimeForActorSync,
} from "../runtime-access/runtime-access.ts";

const RUNTIME_COORDINATOR = "系统提示";

export function listActiveEmployeesSync(workspaceId?: string): ActiveEmployee[] {
  return ensureWorkspaceStateSync(workspaceId).activeEmployees;
}

export function listEmployeeRuntimeBindingsForWorkspaceSync(
  workspaceId?: string,
): ReturnType<typeof listEmployeeRuntimeBindingsSync> {
  return listEmployeeRuntimeBindingsSync(workspaceId);
}

export function listEmployeeSkillIdsMapSync(workspaceId?: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const assignment of listStoredAgentSkillAssignmentsSync(workspaceId)) {
    const employeeName = assignment.employeeName;
    const next = map.get(employeeName) ?? [];
    next.push(assignment.skillId);
    map.set(employeeName, next);
  }
  return map;
}

export function listEmployeeSkillIdsByAgentIdMapSync(workspaceId?: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const assignment of listStoredAgentSkillAssignmentsSync(workspaceId)) {
    const agentId = assignment.agentId?.trim() || buildLegacyAgentIdForEmployeeName(assignment.employeeName);
    const next = map.get(agentId) ?? [];
    next.push(assignment.skillId);
    map.set(agentId, next);
  }
  return map;
}

export function listEmployeeSkillIdsSync(employeeName: string, workspaceId?: string): string[] {
  const byAgentId = listEmployeeSkillIdsByAgentIdMapSync(workspaceId);
  const byName = listEmployeeSkillIdsMapSync(workspaceId);
  return byAgentId.get(buildLegacyAgentIdForEmployeeName(employeeName)) ?? byName.get(employeeName) ?? [];
}

export function buildLegacyAgentIdForEmployeeName(employeeName: string): string {
  return `agent:${employeeName.trim()}`;
}

export function assertRuntimeCanBindEmployeeSync(runtimeId: string): void {
  const runtime = readAgentRuntimeSync(runtimeId);
  if (resolveAgentRuntimeMode() !== "remote") {
    return;
  }
  if (!runtime?.managedCredentialId) {
    throw new Error("runtime.managed_runtime_required");
  }
  if (runtime.provisioningState !== "managed" || runtime.status !== "online") {
    throw new Error("runtime.managed_runtime_not_ready");
  }
}

export function bindEmployeeRuntimeSync(
  employeeName: string,
  runtimeId: string,
  workspaceId?: string,
  actorUserId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }
  if (actorUserId) {
    assertCanManageEmployeeForActorSync({ workspaceId, employeeName: employee.name, actorUserId });
    assertCanUseRuntimeForActorSync({ workspaceId, runtimeId, actorUserId });
  }

  // Enforce the managed-runtime "allow new employee sharing" policy: a runtime
  // with allowNewEmployeeSharing === false refuses to bind ADDITIONAL employees,
  // but re-binding an employee already on this runtime stays permitted.
  assertRuntimeCanBindEmployeeSync(runtimeId);
  const runtimeRecord = readAgentRuntimeSync(runtimeId);
  if (runtimeRecord && runtimeRecord.allowNewEmployeeSharing === false) {
    const existingBinding = readEmployeeRuntimeBindingSync(employee.name, workspaceId);
    if (!existingBinding || existingBinding.runtimeId !== runtimeId) {
      throw new Error("runtime.sharing_closed");
    }
  }

  const binding = bindEmployeeRuntimeRecordSync({
    workspaceId,
    employeeName: employee.name,
    runtimeId,
  });

  state.ledger.unshift({
    title: "Runtime bound",
    note: `${employee.name} was bound to ${binding.runtimeName}.`,
  });
  pushWorkspaceMessageIfChannel(state, employee.channels[0], {
    speaker: RUNTIME_COORDINATOR,
    role: "agent",
    summary: `${employee.name} is now bound to native runtime ${binding.runtimeName}.`,
    code: "runtime.bound",
    data: { employee_name: employee.name, runtime_name: binding.runtimeName },
  }, workspaceId);

  return writeWorkspaceStateSync(state, workspaceId);
}

export function unbindEmployeeRuntimeSync(employeeName: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  const removed = unbindEmployeeRuntimeRecordSync(employee.name, workspaceId);
  if (!removed) {
    throw new Error(`${employee.name} 当前没有绑定 runtime。`);
  }

  state.ledger.unshift({
    title: "Runtime unbound",
    note: `${employee.name} was unbound from the native runtime.`,
  });
  pushWorkspaceMessageIfChannel(state, employee.channels[0], {
    speaker: RUNTIME_COORDINATOR,
    role: "agent",
    summary: `${employee.name} was unbound from the native runtime.`,
    code: "runtime.unbound",
    data: { employee_name: employee.name },
  }, workspaceId);

  return writeWorkspaceStateSync(state, workspaceId);
}

export function deleteEmployeeSync(employeeName: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }
  const directChannelNames = state.channels
    .filter((channel) => isDirectChannel(channel) && channel.employeeNames.some((name) => sameValue(name, employee.name)))
    .map((channel) => channel.name);
  const removedAttachments = state.messages
    .filter((message) => directChannelNames.some((channelName) => sameValue(message.channel ?? "", channelName)))
    .flatMap((message) => message.attachments ?? []);
  const noticeChannel =
    employee.channels.find(
      (channelName) =>
        !directChannelNames.some((directChannelName) => sameValue(directChannelName, channelName)) &&
        state.channels.some((channel) => sameValue(channel.name, channelName)),
    ) ?? undefined;

  const removedOpenTasks = state.tasks.filter(
    (task) => sameValue(task.assignee, employee.name) && task.status !== "done",
  ).length;

  deleteEmployeeExecutionStateSync(employee.name, workspaceId);

  state.activeEmployees = state.activeEmployees.filter((item) => !sameValue(item.name, employee.name));
  state.directConversations = state.directConversations.filter((thread) => !sameValue(thread.contactId, employee.name));
  state.conversationExecutionWorkspaces = (state.conversationExecutionWorkspaces ?? []).filter(
    (workspace) => !sameValue(workspace.agentId, employee.name),
  );
  for (const directChannelName of directChannelNames) {
    removeChannelArtifactsFromState(state, directChannelName, workspaceId);
  }
  state.channels = state.channels.map((channel) =>
    isDirectChannel(channel)
      ? channel
      : {
          ...channel,
          employeeNames: channel.employeeNames.filter((name) => !sameValue(name, employee.name)),
        },
  );
  state.tasks = state.tasks.filter((task) => !sameValue(task.assignee, employee.name));
  state.pendingHandoffs = Math.max(0, state.pendingHandoffs - removedOpenTasks - 1);
  setStoredEmployeeSkillAssignmentsSync(employee.name, [], workspaceId);
  deleteStoredKnowledgeAssignmentsForEmployeeSync(employee.name, workspaceId);
  deleteStoredEmployeeSync(employee.name, workspaceId);
  replaceStoredChannelsSync(state.channels, workspaceId);
  deleteStoredTasksForAssigneeSync(employee.name, workspaceId);

  state.ledger.unshift({
    title: "Agent deleted",
    note: `${employee.name} was removed from the workspace along with bindings, tasks, and work areas.`,
  });
  pushWorkspaceMessageIfChannel(state, noticeChannel, {
    speaker: RUNTIME_COORDINATOR,
    role: "agent",
    summary: `${employee.name} was deleted together with its container binding and work area records.`,
    code: "agent.deleted",
    data: { employee_name: employee.name },
  }, workspaceId);

  const written = writeWorkspaceStateSync(state, workspaceId);
  deleteUnreferencedWorkspaceAttachmentsSync(removedAttachments, written);
  return written;
}

export function updateEmployeeInstructionsSync(employeeName: string, instructions: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  employee.instructions = instructions.trim();
  updateStoredEmployeeSync(employeeName, employee, workspaceId);
  state.ledger.unshift({
    title: "Agent instructions updated",
    note: `${employee.remarkName ?? employee.name} instructions were updated.`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateEmployeeDefaultModelSync(
  employeeName: string,
  defaultModel: string | undefined,
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  const previous = employee.defaultModel;
  employee.defaultModel = defaultModel?.trim() || undefined;
  updateStoredEmployeeSync(employeeName, employee, workspaceId);
  state.ledger.unshift({
    title: "AI employee default model updated",
    note: `${employee.remarkName ?? employee.name} default model changed from ${previous ?? "inherit"} to ${employee.defaultModel ?? "inherit"}.`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function updateEmployeeExecutionPolicySync(
  employeeName: string,
  executionPolicy: EmployeeExecutionPolicy | undefined,
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  employee.executionPolicy = normalizeExecutionPolicy(executionPolicy);
  updateStoredEmployeeSync(employeeName, employee, workspaceId);
  state.ledger.unshift({
    title: "AI employee execution policy updated",
    note: `${employee.remarkName ?? employee.name} execution policy was updated.`,
  });
  return writeWorkspaceStateSync(state, workspaceId);
}

function normalizeExecutionPolicy(value: EmployeeExecutionPolicy | undefined): EmployeeExecutionPolicy | undefined {
  if (!value) return undefined;
  const policy: EmployeeExecutionPolicy = {
    claudePermissionMode: value.claudePermissionMode,
    codexApprovalPolicy: value.codexApprovalPolicy,
    codexSandboxMode: value.codexSandboxMode,
  };
  return Object.values(policy).some(Boolean) ? policy : undefined;
}

export function updateEmployeeRemarkNameSync(employeeName: string, remarkName: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  const nextRemarkName = remarkName.trim() || employee.name;
  employee.remarkName = nextRemarkName;
  updateStoredEmployeeSync(employee.name, employee, workspaceId);
  state.ledger.unshift({
    title: "Agent remark updated",
    note: `${employee.name} display name was updated to ${nextRemarkName}.`,
  });

  return writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
}

export function createEmployeeSync(input: {
  name: string;
  role?: string;
  remarkName?: string;
  summary?: string;
  traits?: string[];
  fit?: string;
  origin?: string;
  active?: boolean;
  instructions?: string;
  skillIds?: string[];
  ownerUserId?: string;
  channelMemberAccess?: AgentChannelMemberAccess;
  defaultModel?: string;
}, workspaceId?: string): DofeAgentState {
  const workspaceSkills = listWorkspaceSkillsSync(workspaceId);
  const state = ensureWorkspaceStateSync(workspaceId);

  if (state.activeEmployees.some((employee) => sameValue(employee.name, input.name))) {
    throw new Error(`Active employee "${input.name}" already exists.`);
  }

  const activeEmployee: ActiveEmployee = {
    name: input.name,
    role: input.role ?? "Agent",
    remarkName: input.remarkName?.trim() || input.name,
    ownerUserId: input.ownerUserId?.trim() || undefined,
    channelMemberAccess: input.channelMemberAccess ?? (input.ownerUserId?.trim() ? "disabled" : "enabled"),
    defaultModel: input.defaultModel?.trim() || undefined,
    origin: input.origin ?? "manual",
    summary: input.summary ?? `${input.name} joined the workspace directly.`,
    traits: input.traits ?? [],
    fit: input.fit ?? "Ready to collaborate immediately.",
    skillIds: normalizeSkillIds(input.skillIds, workspaceSkills),
    channels: [],
    status: "active",
    instructions: input.instructions?.trim() || "",
  };

  state.activeEmployees.push(activeEmployee);
  createStoredEmployeeSync(activeEmployee, workspaceId);
  setStoredEmployeeSkillAssignmentsSync(activeEmployee.name, activeEmployee.skillIds, workspaceId);
  state.pendingHandoffs += 1;
  state.ledger.unshift({
    title: "Employee created",
    note: `${input.name} joined the workspace directly and is waiting to be added to channels.`,
  });

  return writeWorkspaceStateSync(state, workspaceId);
}

export function setEmployeeChannelMemberAccessSync(
  employeeName: string,
  channelMemberAccess: AgentChannelMemberAccess,
  workspaceId?: string,
): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
  if (!employee) {
    throw new Error(`Active employee "${employeeName}" does not exist.`);
  }

  employee.channelMemberAccess = channelMemberAccess;
  updateStoredEmployeeSync(employee.name, employee, workspaceId);
  state.ledger.unshift({
    title: "Agent channel access updated",
    note:
      channelMemberAccess === "enabled"
        ? `${employee.remarkName ?? employee.name} can be used by members in joined channels.`
        : `${employee.remarkName ?? employee.name} is restricted to workspace managers and direct owners.`,
  });

  return writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
}

export function setEmployeeSkillIdsSync(employeeName: string, skillIds: string[], workspaceId?: string): DofeAgentState {
  const resolvedWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  return withTransaction(db, () => {
    const employeeRow = db.prepare(
      `SELECT name FROM workspace_employee
       WHERE workspace_id = ? AND LOWER(name) = LOWER(?)
       FOR UPDATE`,
    ).get(resolvedWorkspaceId, employeeName.trim());
    if (!employeeRow) {
      throw new Error(`Active employee "${employeeName}" does not exist.`);
    }
    const workspaceSkills = listWorkspaceSkillsSync(resolvedWorkspaceId);
    const state = ensureWorkspaceStateSync(resolvedWorkspaceId);
    const employee = state.activeEmployees.find((item) => sameValue(item.name, employeeName));
    if (!employee) {
      throw new Error(`Active employee "${employeeName}" does not exist.`);
    }

    const normalizedSkillIds = normalizeSkillIds(skillIds, workspaceSkills);
    if (normalizedSkillIds.length !== uniqueStringValues(skillIds).length) {
      throw new Error("One or more skills do not exist.");
    }

    employee.skillIds = normalizedSkillIds;
    setStoredEmployeeSkillAssignmentsSync(employee.name, normalizedSkillIds, resolvedWorkspaceId);
    state.ledger.unshift({
      title: "Agent skill assignments updated",
      note: `${employee.remarkName ?? employee.name} skill assignments were updated with ${employee.skillIds.length} item(s).`,
    });

    return writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), resolvedWorkspaceId);
  });
}
