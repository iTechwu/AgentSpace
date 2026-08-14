// 运行时与 daemon 域权限树节点构建。
import {
  listDaemonApiTokensSync,
  listDaemonSnapshotsSync,
  listEmployeeRuntimeBindingsSync,
  listRuntimeGrantsSync,
} from "@dofe-agent/db";
import type {
  PermissionBinding,
  PermissionBuildContext,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  buildWorkspaceManagerInheritedBindings,
  memberLabel,
} from "./permission-utils.ts";

export function buildRuntimeAndDaemonNodes(context: PermissionBuildContext): PermissionTreeNode[] {
  const runtimeGrants = listRuntimeGrantsSync(context.workspaceId);
  const runtimeBindings = listEmployeeRuntimeBindingsSync(context.workspaceId);
  const managerBindings = context.isManager ? buildWorkspaceManagerInheritedBindings(context, "manage/use") : [];
  const nodes: PermissionTreeNode[] = [];

  if (context.isManager) {
    for (const token of listDaemonApiTokensSync(context.workspaceId)) {
      nodes.push({
        id: `daemon-token:${token.id}`,
        parentId: context.workspaceNodeId,
        resourceType: "daemon",
        label: token.label,
        status: token.status === "active" ? "active" : "revoked",
        source: "direct_grant",
        metadata: {
          tokenId: token.id,
          label: token.label,
          status: token.status,
          createdBy: token.createdBy,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt ?? null,
          revokedAt: token.revokedAt ?? null,
        },
        bindings: [
          {
            subjectType: "daemon_token",
            subjectId: token.id,
            subjectLabel: token.label,
            permission: "daemon registration",
            source: "direct_grant",
            status: token.status === "active" ? "active" : "revoked",
            editable: token.status === "active",
            revokeAction: token.status === "active" ? "daemon_token_revoke" : undefined,
            lastChangedAt: token.revokedAt ?? token.lastUsedAt ?? token.createdAt,
            metadata: {
              tokenId: token.id,
              label: token.label,
              status: token.status,
            },
          },
        ],
      });
    }
  }

  if (!context.isManager) {
    for (const snapshot of listDaemonSnapshotsSync(context.workspaceId)) {
      for (const runtime of snapshot.runtimes) {
        if (!context.visibleRuntimeIds.has(runtime.id)) {
          continue;
        }
        nodes.push({
          id: `runtime:${runtime.id}`,
          parentId: context.workspaceNodeId,
          resourceType: "runtime",
          label: context.runtimeLabelById.get(runtime.id) ?? runtime.name,
          status: runtime.status === "online" ? "active" : "error",
          source: "runtime_grant",
          metadata: {
            runtimeId: runtime.id,
            provider: runtime.provider,
            name: runtime.name,
            status: runtime.status,
            lastHeartbeatAt: runtime.lastHeartbeatAt ?? null,
            lastError: runtime.lastError ?? null,
          },
          bindings: [
            ...runtimeGrants
              .filter((grant) => grant.runtimeId === runtime.id && grant.userId === context.actor.userId)
              .map((grant) => {
                const member = context.memberByUserId.get(grant.userId);
                return {
                  subjectType: "human",
                  subjectId: grant.userId,
                  subjectLabel: member ? memberLabel(member) : grant.userId,
                  permission: grant.permission,
                  source: "runtime_grant",
                  status: grant.status === "active" ? "active" : "revoked",
                  editable: false,
                  lastChangedAt: grant.updatedAt,
                  metadata: {
                    runtimeId: runtime.id,
                    userId: grant.userId,
                    permission: grant.permission,
                    status: grant.status,
                  },
                } satisfies PermissionBinding;
              }),
            ...runtimeBindings
              .filter((binding) => binding.runtimeId === runtime.id)
              .filter((binding) => context.visibleEmployees.some((employee) => employee.name === binding.employeeName))
              .map((binding) => {
                const employee = context.visibleEmployees.find((item) => item.name === binding.employeeName);
                return {
                  subjectType: "agent",
                  subjectId: binding.employeeName,
                  subjectLabel: employee?.remarkName ?? binding.employeeName,
                  permission: "bound runtime",
                  source: "direct_grant",
                  status: "active",
                  editable: employee?.ownerUserId === context.actor.userId,
                  revokeAction: employee?.ownerUserId === context.actor.userId ? "agent_runtime_unbind" : undefined,
                  lastChangedAt: binding.updatedAt,
                  metadata: {
                    runtimeId: runtime.id,
                    employeeName: binding.employeeName,
                  },
                } satisfies PermissionBinding;
              }),
          ],
        });
      }
    }
    return nodes;
  }

  for (const snapshot of listDaemonSnapshotsSync(context.workspaceId)) {
    if (!context.isManager && !snapshot.runtimes.some((runtime) => context.visibleRuntimeIds.has(runtime.id))) {
      continue;
    }
    const daemonNode: PermissionTreeNode = {
      id: `daemon:${snapshot.daemon.id}`,
      parentId: context.workspaceNodeId,
      resourceType: "daemon",
      label: snapshot.daemon.deviceName,
      status: snapshot.daemon.status === "online" ? "active" : "error",
      source: "derived",
      metadata: {
        daemonId: snapshot.daemon.id,
        daemonKey: context.isManager ? snapshot.daemon.daemonKey : null,
        status: snapshot.daemon.status,
        lastHeartbeatAt: snapshot.daemon.lastHeartbeatAt ?? null,
      },
      bindings: managerBindings,
      children: [],
    };
    for (const runtime of snapshot.runtimes) {
      if (!context.isManager && !context.visibleRuntimeIds.has(runtime.id)) {
        continue;
      }
      daemonNode.children?.push({
        id: `runtime:${runtime.id}`,
        parentId: daemonNode.id,
        resourceType: "runtime",
        label: context.runtimeLabelById.get(runtime.id) ?? runtime.name,
        status: runtime.status === "online" ? "active" : "error",
        source: "runtime_grant",
        metadata: {
          runtimeId: runtime.id,
          provider: runtime.provider,
          name: runtime.name,
          status: runtime.status,
          lastHeartbeatAt: runtime.lastHeartbeatAt ?? null,
          lastError: runtime.lastError ?? null,
        },
        bindings: [
          ...managerBindings,
          ...runtimeGrants
            .filter((grant) => grant.runtimeId === runtime.id)
            .filter((grant) => context.isManager || grant.userId === context.actor.userId)
            .map((grant) => {
              const member = context.memberByUserId.get(grant.userId);
              return {
                subjectType: "human",
                subjectId: grant.userId,
                subjectLabel: member ? memberLabel(member) : grant.userId,
                permission: grant.permission,
                source: "runtime_grant",
                status: grant.status === "active" ? "active" : "revoked",
                editable: context.isManager && grant.status === "active",
                revokeAction: context.isManager && grant.status === "active" ? "runtime_grant_revoke" : undefined,
                lastChangedAt: grant.updatedAt,
                metadata: {
                  runtimeId: runtime.id,
                  userId: grant.userId,
                  permission: grant.permission,
                  status: grant.status,
                },
              } satisfies PermissionBinding;
            }),
          ...runtimeBindings
            .filter((binding) => binding.runtimeId === runtime.id)
            .filter((binding) => context.visibleEmployees.some((employee) => employee.name === binding.employeeName))
            .map((binding) => {
              const employee = context.visibleEmployees.find((item) => item.name === binding.employeeName);
              return {
                subjectType: "agent",
                subjectId: binding.employeeName,
                subjectLabel: employee?.remarkName ?? binding.employeeName,
                permission: "bound runtime",
                source: "direct_grant",
                status: "active",
                editable: context.isManager || employee?.ownerUserId === context.actor.userId,
                revokeAction: "agent_runtime_unbind",
                lastChangedAt: binding.updatedAt,
                metadata: {
                  runtimeId: runtime.id,
                  employeeName: binding.employeeName,
                },
              } satisfies PermissionBinding;
            }),
        ],
      });
    }
    nodes.push(daemonNode);
  }

  return nodes;
}
