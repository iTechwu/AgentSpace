"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  cancelProvisioningAction,
  deleteManagedRuntimeAction,
  retryProvisioningAction,
  rotateManagedRuntimeCredentialAction,
  stopManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { ManagedRuntimeList } from "@/features/runtimes/managed-runtime-list";
import { ManagedRuntimeCreationWizard } from "@/features/runtimes/managed-runtime-creation-wizard";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ManagedRuntimeListItem, PublicRuntimeProvisioningTaskRecord } from "@dofe-agent/services";

export function RuntimesPageClient({
  workspaceSlug,
  isAdmin,
  initialTasks,
  initialRuntimes,
  targetServers,
}: {
  workspaceSlug: string;
  isAdmin: boolean;
  initialTasks: PublicRuntimeProvisioningTaskRecord[];
  initialRuntimes: ManagedRuntimeListItem[];
  targetServers: Array<{ deviceName: string; status: "online" | "offline" }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!isAdmin) {
    return (
      <section className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Managed Runtimes</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          Only workspace owners and admins can manage managed runtimes.
        </p>
      </section>
    );
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  return (
    <section className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Managed Runtimes</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
          Each managed runtime gets its own models.dofe.ai RuntimeCredential. Provisioning is an
          async, resumable task — you can leave this page.
        </p>
      </header>

      <ManagedRuntimeCreationWizard
        targetServers={targetServers}
        onCreated={(taskId) => router.push(buildWorkspacePath(workspaceSlug, `/runtimes/${taskId}`))}
      />

      <div>
        <h2 className="mb-3 text-sm font-medium">Runtimes</h2>
        <ManagedRuntimeList
          runtimes={initialRuntimes}
          workspaceSlug={workspaceSlug}
          pending={pending}
          onRotate={(runtimeId) =>
            startTransition(async () => {
              await rotateManagedRuntimeCredentialAction(runtimeId, "manual");
              refresh();
            })
          }
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium">Provisioning tasks</h2>
        {initialTasks.length === 0 ? (
          <p className="text-sm text-neutral-500">No managed runtimes yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {initialTasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <Link
                  href={buildWorkspacePath(workspaceSlug, `/runtimes/${task.id}`)}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {formatDaemonProviderLabel(task.runtimeType)}
                </Link>
                <StatusBadge status={task.status} />
                <span className="text-neutral-500">
                  {task.stage} · {task.progressPercent}%
                </span>
                {task.runtimeCredentialId ? (
                  <span className="font-mono text-xs text-neutral-400">
                    {task.runtimeCredentialId.slice(0, 12)}
                  </span>
                ) : null}
                <div className="ml-auto flex gap-2">
                  {task.status === "failed" || task.status === "retrying" ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await retryProvisioningAction(task.id);
                          refresh();
                        })
                      }
                    >
                      Retry
                    </ActionButton>
                  ) : null}
                  {task.status === "running" || task.status === "queued" || task.status === "retrying" || task.status === "failed" ? (
                    <ActionButton
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await cancelProvisioningAction(task.id, "ui_cancel");
                          refresh();
                        })
                      }
                    >
                      Cancel
                    </ActionButton>
                  ) : null}
                  {task.status === "succeeded" && task.runtimeId ? (
                    <>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await rotateManagedRuntimeCredentialAction(task.runtimeId!, "manual");
                            refresh();
                          })
                        }
                      >
                        Rotate key
                      </ActionButton>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await stopManagedRuntimeAction(task.runtimeId!, "ui_stop");
                            refresh();
                          })
                        }
                      >
                        Stop
                      </ActionButton>
                      <ActionButton
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            await deleteManagedRuntimeAction(task.runtimeId!, "ui_delete");
                            refresh();
                          })
                        }
                      >
                        Delete
                      </ActionButton>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: PublicRuntimeProvisioningTaskRecord["status"] }) {
  const tone: Record<PublicRuntimeProvisioningTaskRecord["status"], string> = {
    queued: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
    retrying: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
    cancelling: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
    succeeded: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200",
    failed: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
    cancelled: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone[status]}`}>{status}</span>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
