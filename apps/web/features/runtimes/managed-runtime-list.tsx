"use client";

import { useMemo, useState } from "react";
import { DAEMON_PROVIDER_IDS, formatDaemonProviderLabel } from "@dofe-agent/domain";
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
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const [costAttribution, setCostAttribution] = useState("");
  const models = useMemo(
    () => [...new Set(runtimes.map((runtime) => runtime.defaultModel).filter(Boolean))].sort() as string[],
    [runtimes],
  );
  const filtered = runtimes.filter((runtime) =>
    (!provider || runtime.provider === provider)
    && (!status || runtimeStatusFilter(runtime) === status)
    && (!model || runtime.defaultModel === model)
    && (!costAttribution || (costAttribution === "unallocated") === (runtime.unallocatedCostUsd > 0)),
  );

  if (runtimes.length === 0) {
    return <p className="text-sm text-neutral-500">No provisioned runtimes yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Runtime filters">
        <FilterSelect label="Provider" value={provider} onChange={setProvider}>
          {DAEMON_PROVIDER_IDS.map((id) => <option key={id} value={id}>{formatDaemonProviderLabel(id)}</option>)}
        </FilterSelect>
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="available">Available</option>
          <option value="offline">Offline</option>
          <option value="recovering">Credential recovery</option>
          <option value="attention">Needs attention</option>
          <option value="stopped">Stopped</option>
        </FilterSelect>
        <FilterSelect label="Model" value={model} onChange={setModel}>
          {models.map((item) => <option key={item} value={item}>{item}</option>)}
        </FilterSelect>
        <FilterSelect label="Cost attribution" value={costAttribution} onChange={setCostAttribution}>
          <option value="allocated">Allocated</option>
          <option value="unallocated">Has unallocated cost</option>
        </FilterSelect>
      </div>
      <div className="overflow-x-auto rounded border">
        <table className="w-full min-w-[880px] text-left text-sm" aria-label="Managed runtimes">
          <thead className="border-b bg-neutral-50 text-xs text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="p-3 font-medium">Name</th><th className="p-3 font-medium">Provider / protocol</th>
              <th className="p-3 font-medium">Status</th><th className="p-3 font-medium">Default model</th>
              <th className="p-3 font-medium">AI employees</th><th className="p-3 font-medium">Last heartbeat</th>
              <th className="p-3 font-medium">Period actual cost</th><th className="p-3 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
      {filtered.map((runtime) => {
        const presentation = presentRuntimeState(runtime);
        return (
          <tr key={runtime.id}>
            <td className="p-3 font-medium">{runtime.name}</td>
            <td className="p-3"><span className="block">{formatDaemonProviderLabel(runtime.provider)}</span><span className="text-xs text-neutral-500">{runtime.protocols.join(", ") || "—"}</span></td>
            <td className="p-3"><span className={`rounded px-2 py-0.5 text-xs font-medium ${presentation.tone}`}>{presentation.label}</span><span className="mt-1 block max-w-48 text-xs text-neutral-500">{presentation.detail}</span></td>
            <td className="p-3">{runtime.defaultModel || "System fallback"}</td>
            <td className="p-3 tabular-nums">{runtime.assignedEmployeeCount}</td>
            <td className="p-3 text-xs">{formatHeartbeat(runtime.lastHeartbeatAt)}</td>
            <td className="p-3 tabular-nums"><span>${runtime.periodActualCostUsd.toFixed(4)}</span>{runtime.unallocatedCostUsd > 0 ? <span className="block text-xs text-amber-700">${runtime.unallocatedCostUsd.toFixed(4)} unallocated</span> : null}</td>
            <td className="p-3 text-right">{runtime.provisioningState === "needs_attention" ? (
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                disabled={pending}
                onClick={() => onRotate(runtime.id)}
              >
                Rotate key
              </button>
            ) : null}</td>
          </tr>
        );
      })}
          </tbody>
        </table>
        {filtered.length === 0 ? <p className="p-4 text-sm text-neutral-500">No runtimes match these filters.</p> : null}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="text-xs"><span className="mb-1 block text-neutral-500">{label}</span><select className="w-full rounded border px-2 py-1.5 text-sm" value={value} onChange={(event) => onChange(event.target.value)}><option value="">All</option>{children}</select></label>;
}

function runtimeStatusFilter(runtime: ManagedRuntimeListItem): string {
  if (runtime.provisioningState === "credential_recovering") return "recovering";
  if (runtime.provisioningState === "needs_attention") return "attention";
  if (runtime.provisioningState === "legacy") return "stopped";
  return runtime.status === "online" ? "available" : "offline";
}

function formatHeartbeat(value: string | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
