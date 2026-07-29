import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { listManagedRuntimesForWorkspaceSync, resolveAgentRuntimeMode } from "@dofe-agent/services";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";
import { getWorkspacePageContext } from "../../../_lib/workspace-page-context";
import { ManagedRuntimeSharingToggle } from "@/features/runtimes/managed-runtime-sharing-toggle";
import { ManagedRuntimeModelSettings } from "@/features/runtimes/managed-runtime-model-settings";

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

  const presentation = presentRuntimeState(runtime.provisioningState, runtime.status);

  return (
    <section className="page-shell runtime-detail">
      <header className="runtime-detail__header">
        <Link
          className="runtime-detail__back"
          href={buildWorkspacePath(workspaceContext.currentWorkspace.slug, "/runtimes")}
        >
          Back to runtimes
        </Link>
        <div className="runtime-detail__identity">
          <div className="runtime-detail__provider" aria-hidden="true">
            {formatDaemonProviderLabel(runtime.provider).slice(0, 1)}
          </div>
          <div className="runtime-detail__title">
            <div className="runtime-detail__eyebrow">Managed runtime</div>
            <h1>{runtime.name}</h1>
            <p>{formatDaemonProviderLabel(runtime.provider)} deployment</p>
          </div>
          <div className="runtime-detail__status" aria-label={`Status: ${presentation.label}`}>
            <span className={`runtime-status runtime-status--${presentation.tone}`}>{presentation.label}</span>
            <span>{presentation.detail}</span>
          </div>
        </div>
      </header>

      <div className="runtime-detail__layout">
        <section className="runtime-detail__section runtime-detail__section--configuration" aria-labelledby="runtime-configuration-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>Configuration</span>
              <h2 id="runtime-configuration-title">Connection profile</h2>
            </div>
            <p>How this runtime accepts work.</p>
          </div>
          <dl className="runtime-detail__fields">
            <RuntimeField label="Default model" value={runtime.defaultModel || "System fallback"} />
            <RuntimeField label="Protocols" value={runtime.protocols.join(", ") || "None reported"} />
            <RuntimeField label="Last heartbeat" value={formatHeartbeat(runtime.lastHeartbeatAt)} />
            <RuntimeField label="Runtime credential" value={formatCredential(runtime.managedCredentialId)} mono />
          </dl>
          <ManagedRuntimeModelSettings runtimeId={runtime.id} defaultModel={runtime.defaultModel} />
        </section>

        <section className="runtime-detail__section runtime-detail__section--usage" aria-labelledby="runtime-usage-title">
          <div className="runtime-detail__section-heading">
            <div>
              <span>Capacity and spend</span>
              <h2 id="runtime-usage-title">Current period</h2>
            </div>
            <p>Usage attributed to this runtime.</p>
          </div>
          <dl className="runtime-detail__metrics">
            <RuntimeMetric label="AI employees" value={String(runtime.assignedEmployeeCount)} />
            <RuntimeMetric label="Actual cost" value={formatCny(runtime.periodActualCostUsd)} />
            <RuntimeMetric label="Unallocated" value={formatCny(runtime.unallocatedCostUsd)} warning={runtime.unallocatedCostUsd > 0} />
          </dl>
        </section>
      </div>

      <section className="runtime-detail__section runtime-detail__section--sharing" aria-labelledby="runtime-sharing-title">
        <div className="runtime-detail__section-heading">
          <div>
            <span>Access policy</span>
            <h2 id="runtime-sharing-title">Share with AI employees</h2>
          </div>
          <p>Control whether newly created employees can use this runtime.</p>
        </div>
        <ManagedRuntimeSharingToggle
          runtimeId={runtime.id}
          allowNewEmployeeSharing={runtime.allowNewEmployeeSharing !== false}
        />
      </section>
    </section>
  );
}

function RuntimeField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="runtime-detail__field">
      <dt>{label}</dt>
      <dd className={mono ? "runtime-detail__value--mono" : undefined}>{value}</dd>
    </div>
  );
}

function RuntimeMetric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className="runtime-detail__metric">
      <dt>{label}</dt>
      <dd className={warning ? "runtime-detail__metric--warning" : undefined}>{value}</dd>
    </div>
  );
}

function presentRuntimeState(
  state: "managed" | "credential_recovering" | "needs_attention" | "legacy",
  status: "online" | "offline",
): { label: string; detail: string; tone: "available" | "recovering" | "attention" | "stopped" } {
  if (state === "credential_recovering") return { label: "Credential recovery", detail: "Updating secure access", tone: "recovering" };
  if (state === "needs_attention") return { label: "Needs attention", detail: "Requires an administrator", tone: "attention" };
  if (state === "legacy") return { label: "Stopped", detail: "Not accepting new work", tone: "stopped" };
  return status === "online"
    ? { label: "Available", detail: "Ready to receive work", tone: "available" }
    : { label: "Offline", detail: "Awaiting a node heartbeat", tone: "attention" };
}

function formatHeartbeat(value?: string): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCredential(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatCny(value: number): string {
  return `¥${value.toFixed(4)}`;
}
