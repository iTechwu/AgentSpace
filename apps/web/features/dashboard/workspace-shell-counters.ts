import type {
  WorkspaceShellCounterData,
  WorkspaceShellData,
} from "@/features/dashboard/workspace-shell-data";

export type WorkspaceShellCounters = WorkspaceShellCounterData;

export function deriveWorkspaceShellCounters(shell: WorkspaceShellData | WorkspaceShellCounterData): WorkspaceShellCounters {
  if ("humanContactCount" in shell && "agentCount" in shell && "runtimeCount" in shell) {
    return {
      humanMembers: shell.humanMembers,
      channelCount: shell.channelCount,
      messageCount: shell.messageCount,
      unreadNotificationCount: shell.unreadNotificationCount,
      openTaskCount: shell.openTaskCount,
      pendingApprovalCount: shell.pendingApprovalCount,
      localAgentCount: shell.localAgentCount,
      remoteAgentCount: shell.remoteAgentCount,
      skillCount: shell.skillCount,
      knowledgePageCount: shell.knowledgePageCount,
      contactCount: shell.contactCount,
      humanContactCount: shell.humanContactCount,
      agentCount: shell.agentCount,
      runtimeCount: shell.runtimeCount,
    };
  }

  return {
    humanMembers: shell.humanMembers,
    channelCount: shell.channelCount,
    messageCount: shell.messageCount,
    unreadNotificationCount: shell.unreadNotificationCount,
    openTaskCount: shell.openTaskCount,
    pendingApprovalCount: shell.pendingApprovalCount,
    localAgentCount: shell.localAgentCount,
    remoteAgentCount: shell.remoteAgentCount,
    skillCount: shell.skillCount,
    knowledgePageCount: shell.knowledgePageCount,
    contactCount: shell.contactCount,
    humanContactCount: shell.humanContacts.length,
    agentCount: shell.agents.length,
    runtimeCount: shell.directMessages.length,
  };
}
