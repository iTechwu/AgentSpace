"use client";

import { useRef, useState, useTransition } from "react";
import {
  createManagedRuntimeAction,
  preflightManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { DAEMON_PROVIDER_IDS, formatDaemonProviderLabel, type DaemonProvider } from "@dofe-agent/domain";
import type { ManagedRuntimeCreationPreflightResult } from "@dofe-agent/services";

export function ManagedRuntimeCreationWizard({
  onCreated,
}: {
  onCreated: (taskId: string) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<DaemonProvider>(DAEMON_PROVIDER_IDS[0] ?? "claude");
  const [name, setName] = useState("");
  const [targetServer, setTargetServer] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [preflight, setPreflight] = useState<ManagedRuntimeCreationPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);

  function invalidatePreflight() {
    setPreflight(null);
    setError(null);
    idempotencyKey.current = null;
  }

  function continueToConfirmation() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await preflightManagedRuntimeAction({
          provider,
          defaultModel: defaultModel || undefined,
        });
        setPreflight(result);
        setStep(3);
      } catch (preflightError) {
        setError(humanizeRuntimeError(preflightError));
      }
    });
  }

  function createRuntime() {
    if (!preflight?.allowed) return;
    setError(null);
    idempotencyKey.current ??= `ui:${provider}:${crypto.randomUUID()}`;
    startTransition(async () => {
      try {
        const result = await createManagedRuntimeAction({
          provider,
          name: name.trim() || undefined,
          defaultModel: defaultModel || undefined,
          allowedModels: defaultModel ? [defaultModel] : undefined,
          targetServer: targetServer.trim() || undefined,
          idempotencyKey: idempotencyKey.current!,
        });
        onCreated(result.taskId);
      } catch (createError) {
        setError(humanizeRuntimeError(createError));
      }
    });
  }

  return (
    <div className="border-y py-4">
      <div className="mb-5 flex items-start justify-between gap-4">
        <h2 className="text-sm font-medium">Create managed runtime</h2>
        <ol className="flex gap-3 text-xs text-neutral-500" aria-label="Creation progress">
          {["Execution", "Model", "Confirm"].map((label, index) => {
            const number = (index + 1) as 1 | 2 | 3;
            return (
              <li key={label} className={number === step ? "font-medium text-neutral-950 dark:text-white" : ""}>
                <span aria-current={number === step ? "step" : undefined}>{number}. {label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {step === 1 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Runtime name</span>
            <input
              className="w-full rounded border px-2 py-1"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                invalidatePreflight();
              }}
              placeholder={`Managed ${formatDaemonProviderLabel(provider)}`}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Runtime type</span>
            <select
              className="w-full rounded border px-2 py-1"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as DaemonProvider);
                setDefaultModel("");
                invalidatePreflight();
              }}
            >
              {DAEMON_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>{formatDaemonProviderLabel(id)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-500">Target server</span>
            <input
              className="w-full rounded border px-2 py-1"
              value={targetServer}
              onChange={(event) => {
                setTargetServer(event.target.value);
                invalidatePreflight();
              }}
              placeholder="Automatic placement"
            />
          </label>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="max-w-xl">
          <RuntimeModelPicker
            provider={provider}
            value={defaultModel}
            onChange={(value) => {
              setDefaultModel(value);
              invalidatePreflight();
            }}
          />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1">
            <dt className="text-neutral-500">Name</dt>
            <dd>{name.trim() || `Managed ${formatDaemonProviderLabel(provider)}`}</dd>
            <dt className="text-neutral-500">Runtime</dt>
            <dd>{formatDaemonProviderLabel(provider)}</dd>
            <dt className="text-neutral-500">Server</dt>
            <dd>{targetServer.trim() || "Automatic placement"}</dd>
            <dt className="text-neutral-500">Default model</dt>
            <dd>{defaultModel || "System fallback"}</dd>
          </dl>
          <div className={`border-l-2 pl-3 ${preflight?.allowed ? "border-green-600" : "border-red-600"}`}>
            <p className="font-medium">{preflight?.allowed ? "Preflight passed" : "Preflight blocked"}</p>
            <p className="text-xs text-neutral-500">
              {formatPreflightSummary(preflight)}
            </p>
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="mt-3 text-sm text-red-600">{error}</p> : null}

      <div className="mt-5 flex justify-end gap-2">
        {step > 1 ? (
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={pending}
            onClick={() => setStep(step === 3 ? 2 : 1)}
          >
            Back
          </button>
        ) : null}
        {step === 1 ? (
          <button type="button" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-neutral-900" onClick={() => setStep(2)}>
            Continue
          </button>
        ) : null}
        {step === 2 ? (
          <button type="button" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900" disabled={pending} onClick={continueToConfirmation}>
            {pending ? "Checking…" : "Review"}
          </button>
        ) : null}
        {step === 3 ? (
          <button type="button" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900" disabled={pending || !preflight?.allowed} onClick={createRuntime}>
            {pending ? "Creating…" : "Create runtime"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatPreflightSummary(result: ManagedRuntimeCreationPreflightResult | null): string {
  if (!result) return "Preflight has not completed.";
  if (!result.allowed) return result.message || "Model availability or team balance requires attention.";
  if (result.availableBalance !== undefined) {
    return `Available balance: ${result.availableBalance} ${result.currency ?? ""}`.trim();
  }
  return "Model availability and team billing are ready.";
}

function humanizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    "managed_runtime.balance_preflight_rejected": "The team balance is insufficient for this runtime.",
    "managed_runtime.model_unavailable": "The selected model is unavailable for this runtime.",
    "managed_runtime.no_compatible_models": "No available model supports this runtime.",
    "managed_runtime.models_not_configured": "The models service is not configured.",
  };
  return known[message] ?? "The runtime request could not be completed. Review the configuration and try again.";
}
