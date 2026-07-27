"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  cancelProvisioningAction,
  createManagedRuntimeAction,
  deleteManagedRuntimeAction,
  retryProvisioningAction,
  rotateManagedRuntimeCredentialAction,
  stopManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { DAEMON_PROVIDER_IDS, formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { RuntimeProvisioningTaskRecord } from "@dofe-agent/db";

export function RuntimesPageClient({
  workspaceSlug,
  isAdmin,
  initialTasks,
}: {
  workspaceSlug: string;
  isAdmin: boolean;
  initialTasks: RuntimeProvisioningTaskRecord[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState<string>(DAEMON_PROVIDER_IDS[0] ?? "claude");
  const [defaultModel, setDefaultModel] = useState("");
  const [targetServer, setTargetServer] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  function handleCreate() {
    setError(null);
    const idempotencyKey = `ui:${provider}:${Date.now()}`;
    startTransition(async () => {
      try {
        const { taskId } = await createManagedRuntimeAction({
          provider: provider as (typeof DAEMON_PROVIDER_IDS)[number],
          defaultModel: defaultModel.trim() || undefined,
          allowedModels: defaultModel.trim() ? [defaultModel.trim()] : undefined,
          targetServer: targetServer.trim() || undefined,
          idempotencyKey,
        });
        router.push(buildWorkspacePath(workspaceSlug, `/runtimes/${taskId}`));
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : String(createError));
      }
    });
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

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-medium">Create managed runtime</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Runtime type</span>
            <select
              className="w-full rounded border px-2 py-1"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              {DAEMON_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {formatDaemonProviderLabel(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Default model</span>
            <RuntimeModelPicker
              provider={provider as (typeof DAEMON_PROVIDER_IDS)[number]}
              value={defaultModel}
              onChange={setDefaultModel}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Target server (optional)</span>
            <input
              className="w-full rounded border px-2 py-1"
              value={targetServer}
              onChange={(event) => setTargetServer(event.target.value)}
              placeholder="research-runner-01"
            />
          </label>
        </div>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button
          type="button"
          className="mt-3 rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          disabled={pending}
          onClick={handleCreate}
        >
          {pending ? "Creating…" : "Create runtime"}
        </button>
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
                  {task.status === "failed" ? (
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
                  {task.status === "running" || task.status === "queued" ? (
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

function StatusBadge({ status }: { status: RuntimeProvisioningTaskRecord["status"] }) {
  const tone: Record<RuntimeProvisioningTaskRecord["status"], string> = {
    queued: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
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
