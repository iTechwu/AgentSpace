import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { listManagedRuntimesForWorkspaceSync, resolveAgentRuntimeMode } from "@dofe-agent/services";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { getWorkspacePageContext } from "../../../_lib/workspace-page-context";
import { ManagedRuntimeSharingToggle } from "@/features/runtimes/managed-runtime-sharing-toggle";

export const dynamic = "force-dynamic";

export default async function ManagedRuntimeDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; runtimeId: string }>;
}) {
  const { workspaceSlug, runtimeId } = await params;
  if (resolveAgentRuntimeMode() !== "remote") notFound();

  const workspaceContext = await getWorkspacePageContext(workspaceSlug);
  if (!hasWorkspaceRole(workspaceContext.currentMembership.role, "admin")) notFound();
  const runtime = listManagedRuntimesForWorkspaceSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    actorUserId: workspaceContext.currentUser.id,
  }).find((item) => item.id === runtimeId);
  if (!runtime) notFound();

  return (
    <section className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <Link
          className="text-sm text-neutral-600 underline-offset-2 hover:underline dark:text-neutral-300"
          href={buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/runtimes")}
        >
          Back to runtimes
        </Link>
        <div>
          <h1 className="text-xl font-semibold">{runtime.name}</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
            {formatDaemonProviderLabel(runtime.provider)} managed runtime
          </p>
        </div>
      </header>

      <dl className="grid gap-x-8 gap-y-5 border-y py-5 sm:grid-cols-2">
        <RuntimeField label="Status" value={formatRuntimeStatus(runtime.provisioningState, runtime.status)} />
        <RuntimeField label="Default model" value={runtime.defaultModel || "System fallback"} />
        <RuntimeField label="Protocols" value={runtime.protocols.join(", ") || "None reported"} />
        <RuntimeField label="AI employees" value={String(runtime.assignedEmployeeCount)} />
        <RuntimeField label="Runtime credential" value={runtime.managedCredentialId} mono />
        <RuntimeField label="Last heartbeat" value={formatHeartbeat(runtime.lastHeartbeatAt)} />
        <RuntimeField label="Period actual cost" value={`$${runtime.periodActualCostUsd.toFixed(4)}`} />
        <RuntimeField label="Unallocated cost" value={`$${runtime.unallocatedCostUsd.toFixed(4)}`} />
      </dl>

      <div className="space-y-1 border-y py-5">
        <h2 className="text-xs font-medium uppercase text-neutral-500">Sharing</h2>
        <ManagedRuntimeSharingToggle
          runtimeId={runtime.id}
          allowNewEmployeeSharing={runtime.allowNewEmployeeSharing !== false}
        />
        <p className="text-xs text-neutral-500">
          When off, this runtime refuses to bind additional AI employees. Existing bindings are preserved.
        </p>
      </div>
    </section>
  );
}

function RuntimeField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase text-neutral-500">{label}</dt>
      <dd className={`mt-1 break-words text-sm ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function formatRuntimeStatus(
  state: "managed" | "credential_recovering" | "needs_attention" | "legacy",
  status: "online" | "offline",
): string {
  if (state === "credential_recovering") return "Credential recovery";
  if (state === "needs_attention") return "Needs attention";
  if (state === "legacy") return "Stopped";
  return status === "online" ? "Available" : "Offline";
}

function formatHeartbeat(value?: string): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
