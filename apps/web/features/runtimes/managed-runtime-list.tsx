"use client";

import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ManagedRuntimeListItem } from "@dofe-agent/services";

export function ManagedRuntimeList({
  runtimes,
  pending,
  onRotate,
}: {
  runtimes: ManagedRuntimeListItem[];
  pending: boolean;
  onRotate: (runtimeId: string) => void;
}) {
  if (runtimes.length === 0) {
    return <p className="text-sm text-neutral-500">No provisioned runtimes yet.</p>;
  }

  return (
    <ul className="divide-y rounded-lg border" aria-label="Managed runtimes">
      {runtimes.map((runtime) => {
        const presentation = presentRuntimeState(runtime);
        return (
          <li key={runtime.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{runtime.name}</p>
              <p className="text-xs text-neutral-500">
                {formatDaemonProviderLabel(runtime.provider)} · {runtime.managedCredentialId.slice(0, 12)}
              </p>
            </div>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${presentation.tone}`}>
              {presentation.label}
            </span>
            <p className="basis-full text-xs text-neutral-500 sm:basis-auto sm:text-right">
              {presentation.detail}
            </p>
            {runtime.provisioningState === "needs_attention" ? (
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                disabled={pending}
                onClick={() => onRotate(runtime.id)}
              >
                Rotate key
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function presentRuntimeState(runtime: ManagedRuntimeListItem): {
  label: string;
  detail: string;
  tone: string;
} {
  if (runtime.provisioningState === "credential_recovering") {
    return {
      label: "Credential recovery",
      detail: "Updating the gateway credential; new tasks are paused.",
      tone: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
    };
  }
  if (runtime.provisioningState === "needs_attention") {
    return {
      label: "Needs attention",
      detail: "Automatic recovery stopped after three attempts.",
      tone: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
    };
  }
  if (runtime.provisioningState === "legacy") {
    return {
      label: "Stopped",
      detail: "This runtime is not accepting new tasks.",
      tone: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
    };
  }
  return runtime.status === "online"
    ? {
        label: "Available",
        detail: "Credential verified and ready for scheduling.",
        tone: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200",
      }
    : {
        label: "Offline",
        detail: "Waiting for the managed node heartbeat.",
        tone: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
      };
}
