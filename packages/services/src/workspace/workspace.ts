import {
  createDefaultWorkspaceState,
  createWorkspaceSnapshot,
  type DofeAgentState,
  type WorkspaceSnapshot,
} from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync, getWorkspaceDatabaseFilePath } from "../shared/state-io.ts";
import { sameValue } from "../shared/helpers.ts";

export function bootstrapWorkspaceSync(input: {
  organizationName: string;
  ownerName: string;
  ownerRole: string;
  firstChannelName: string;
}, workspaceId?: string): DofeAgentState {
  const state = createDefaultWorkspaceState();
  state.organizationName = input.organizationName;
  state.humanMembers = [{ name: input.ownerName, role: input.ownerRole }];
  state.channels = [
    {
      name: input.firstChannelName,
      humanMembers: 1,
      employeeNames: [],
    },
  ];

  return writeWorkspaceStateSync(state, workspaceId);
}

export function initializeOrganizationSync(input: {
  organizationName: string;
  ownerName: string;
  ownerRole: string;
  firstChannelName?: string;
}, workspaceId?: string): DofeAgentState {
  return bootstrapWorkspaceSync({
    organizationName: input.organizationName,
    ownerName: input.ownerName,
    ownerRole: input.ownerRole,
    firstChannelName: input.firstChannelName ?? "总控室",
  }, workspaceId);
}

export function addHumanMemberSync(input: { name: string; role: string }, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);

  if (!state.humanMembers.some((member) => sameValue(member.name, input.name))) {
    state.humanMembers.push({ name: input.name, role: input.role });
  }

  return writeWorkspaceStateSync(state, workspaceId);
}

export function readWorkspaceSnapshotSync(): WorkspaceSnapshot {
  return createWorkspaceSnapshot(ensureWorkspaceStateSync());
}

export function readWorkspaceSummarySync(): Record<string, string | number> {
  const state = ensureWorkspaceStateSync();
  const snapshot = createWorkspaceSnapshot(state);

  return {
    mode: "im",
    organization: state.organizationName,
    database: getWorkspaceDatabaseFilePath(),
    onlineDigitalEmployees: snapshot.stats[0]?.value ?? "00",
    pendingHandoffs: snapshot.stats[1]?.value ?? "00",
    humanParticipants: snapshot.stats[2]?.value ?? "00",
    channels: state.channels.length,
    materials: state.materials.length,
    messages: state.messages.length,
    tasks: state.tasks.length,
    activeEmployees: state.activeEmployees.length,
  };
}
