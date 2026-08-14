// 权限中心对外门面：装配入口与再导出（保持原导入路径不变）。
import {
  readWorkspaceSync,
} from "@dofe-agent/db";
import {
  listKnowledgeAssignmentPoliciesSync,
} from "../knowledge/assignments.ts";
import {
  buildPermissionContext,
} from "./permission-context.ts";
import {
  attachDiagnostics,
  buildPermissionDiagnostics,
  groupDiagnosticsByNode,
} from "./permission-diagnostics.ts";
import {
  buildAgentAccessRequestNodes,
  buildAgentNodes,
} from "./permission-nodes-agents.ts";
import {
  buildChannelNodes,
  buildWorkspaceBindings,
} from "./permission-nodes-channels.ts";
import {
  buildDocumentAndFileNodes,
  buildDocumentPermissionRequestNodes,
} from "./permission-nodes-documents.ts";
import {
  buildFeishuExternalGuestPolicyNodes,
} from "./permission-nodes-feishu-guests.ts";
import {
  buildRuntimeAndDaemonNodes,
} from "./permission-nodes-runtime.ts";
import type {
  PermissionActorSummary,
  PermissionBuildContext,
  PermissionCenterActorInput,
  PermissionCenterData,
  PermissionDiagnostic,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  actorKey,
  dedupeActorPermissions,
  subjectTypeRank,
} from "./permission-utils.ts";

export * from "./permission-types.ts";

export function getWorkspacePermissionCenterSync(input: {
  workspaceId: string;
  actor: PermissionCenterActorInput;
}): PermissionCenterData {
  const context = buildPermissionContext(input);
  const diagnostics = buildPermissionDiagnostics(input, context);
  const tree = buildWorkspacePermissionTree(input, context, diagnostics);
  const actors = getWorkspaceActorPermissionSummarySync({
    ...input,
    tree,
    diagnostics,
  });

  return {
    tree,
    actors,
    diagnostics,
    catalog: {
      members: context.isManager
        ? Array.from(context.memberByUserId.values())
        : Array.from(context.memberByUserId.values()).filter((member) => member.userId === input.actor.userId),
      agents: context.visibleEmployees.map((employee) => ({
        employeeName: employee.name,
        label: employee.remarkName ?? employee.name,
      })),
      skills: Array.from(context.skillById.values()).map((skill) => ({
        id: skill.id,
        name: skill.name,
      })),
      knowledgePages: listKnowledgeAssignmentPoliciesSync(input.workspaceId).map((policy) => {
        const page = context.state.knowledgePages.find((item) => item.id === policy.knowledgePageId);
        return {
          id: policy.knowledgePageId,
          title: page?.title ?? policy.knowledgePageId,
          assignmentMode: policy.assignmentMode,
        };
      }),
    },
  };
}

export function getWorkspacePermissionTreeSync(input: {
  workspaceId: string;
  actor: PermissionCenterActorInput;
}): PermissionTreeNode[] {
  const context = buildPermissionContext(input);
  const diagnostics = buildPermissionDiagnostics(input, context);
  return buildWorkspacePermissionTree(input, context, diagnostics);
}

export function buildWorkspacePermissionTree(
  input: {
    workspaceId: string;
    actor: PermissionCenterActorInput;
  },
  context: PermissionBuildContext,
  diagnostics: PermissionDiagnostic[],
): PermissionTreeNode[] {
  const workspace = readWorkspaceSync(input.workspaceId);
  const root: PermissionTreeNode = {
    id: context.workspaceNodeId,
    resourceType: "workspace",
    label: workspace?.name ?? input.workspaceId,
    status: "active",
    source: "workspace_role",
    bindings: buildWorkspaceBindings(context),
    metadata: { workspaceId: input.workspaceId },
    children: [],
  };

  const diagnosticsByNode = groupDiagnosticsByNode(diagnostics);
  const sections = [
    buildChannelNodes(context),
    buildAgentNodes(context),
    buildAgentAccessRequestNodes(context),
    buildRuntimeAndDaemonNodes(context),
    buildDocumentAndFileNodes(context),
    buildDocumentPermissionRequestNodes(context),
    buildFeishuExternalGuestPolicyNodes(context),
  ];

  for (const nodes of sections) {
    root.children?.push(...nodes);
  }
  attachDiagnostics(root, diagnosticsByNode);
  return [root];
}

export function getWorkspaceActorPermissionSummarySync(input: {
  workspaceId: string;
  actor: PermissionCenterActorInput;
  tree?: PermissionTreeNode[];
  diagnostics?: PermissionDiagnostic[];
}): PermissionActorSummary[] {
  const tree = input.tree ?? getWorkspacePermissionTreeSync(input);
  const diagnostics = input.diagnostics ?? getPermissionDiagnosticsSync(input);
  const actors = new Map<string, PermissionActorSummary>();

  function visit(node: PermissionTreeNode): void {
    for (const binding of node.bindings) {
      const key = actorKey(binding.subjectType, binding.subjectId);
      const summary = actors.get(key) ?? {
        subjectType: binding.subjectType,
        subjectId: binding.subjectId,
        subjectLabel: binding.subjectLabel,
        status: binding.status === "revoked" ? "revoked" : binding.status === "pending" ? "pending" : binding.status === "external" ? "external" : "active",
        permissions: [],
        diagnostics: [],
      } satisfies PermissionActorSummary;
      summary.permissions.push({
        nodeId: node.id,
        resourceType: node.resourceType,
        resourceLabel: node.label,
        permission: binding.permission,
        source: binding.source,
        status: binding.status,
        editable: binding.editable,
        inheritedFromNodeId: binding.inheritedFromNodeId,
        lastChangedAt: binding.lastChangedAt,
      });
      actors.set(key, summary);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  for (const node of tree) {
    visit(node);
  }

  for (const diagnostic of diagnostics) {
    if (!diagnostic.subjectType || !diagnostic.subjectId) {
      continue;
    }
    const key = actorKey(diagnostic.subjectType, diagnostic.subjectId);
    const summary = actors.get(key);
    if (summary) {
      summary.diagnostics.push(diagnostic);
    }
  }

  return Array.from(actors.values())
    .map((summary) => ({
      ...summary,
      permissions: dedupeActorPermissions(summary.permissions)
        .sort((left, right) => left.resourceLabel.localeCompare(right.resourceLabel, "zh-CN", { sensitivity: "base" })),
    }))
    .sort((left, right) => {
      const typeRank = subjectTypeRank(left.subjectType) - subjectTypeRank(right.subjectType);
      return typeRank || left.subjectLabel.localeCompare(right.subjectLabel, "zh-CN", { sensitivity: "base" });
    });
}

export function getPermissionDiagnosticsSync(input: {
  workspaceId: string;
  actor: PermissionCenterActorInput;
}): PermissionDiagnostic[] {
  return buildPermissionDiagnostics(input, buildPermissionContext(input));
}
