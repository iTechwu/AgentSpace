import type { Metadata } from "next";
import { getRuntimeProvisioningTaskDetailSync, resolveAgentRuntimeMode } from "@dofe-agent/services/runtime";
import { notFound } from "next/navigation";
import { getWorkspacePageContext } from "../../_lib/workspace-page-context";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { RuntimeTaskDetailClient } from "@/features/runtimes/task-detail-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "任务执行详情",
  description: "查看任务执行的过程与产物。",
};

export default async function RuntimeTaskDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; taskId: string }>;
}) {
  const { workspaceSlug, taskId } = await params;
  if (resolveAgentRuntimeMode() !== "remote") {
    notFound();
  }
  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  const isAdmin = hasWorkspaceRole(workspaceContext.currentMembership.role, "admin");
  if (!isAdmin) {
    return (
      <section className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Only workspace owners and admins can view managed runtime tasks.
        </p>
      </section>
    );
  }

  let detail: ReturnType<typeof getRuntimeProvisioningTaskDetailSync> | null = null;
  try {
    detail = getRuntimeProvisioningTaskDetailSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      actorUserId: workspaceContext.currentUser.id,
      taskId,
    });
  } catch {
    detail = null;
  }
  if (!detail) {
    notFound();
  }

  return (
    <RuntimeTaskDetailClient
      workspaceSlug={workspaceContext.currentWorkspace.id}
      initialDetail={detail}
    />
  );
}
