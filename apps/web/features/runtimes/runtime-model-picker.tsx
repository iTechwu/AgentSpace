"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listProtocolFilteredRuntimeModelsAction,
  type RuntimeModelCatalogItem,
} from "@/features/runtimes/actions";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { DaemonProvider } from "@dofe-agent/domain";

export interface RuntimeModelPickerProps {
  provider: DaemonProvider;
  value: string;
  onChange: (value: string) => void;
}

export function RuntimeModelPicker({ provider, value, onChange }: RuntimeModelPickerProps) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<RuntimeModelCatalogItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await listProtocolFilteredRuntimeModelsAction(provider);
        setConfigured(result.configured);
        setItems(result.list);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setItems([]);
      }
    });
  }, [provider]);

  const selected = items.find((item) => item.alias === value || item.model === value);
  const compatibleItems = items.filter((item) => item.isAvailable);

  return (
    <div className="space-y-2">
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Default model</span>
        <select
          className="w-full rounded border px-2 py-1 disabled:opacity-50"
          value={value}
          disabled={pending || !configured}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{pending ? "Loading models…" : "Inherit system fallback"}</option>
          {compatibleItems.map((item) => (
            <option key={item.alias} value={item.alias}>
              {item.displayName ?? item.alias}
            </option>
          ))}
        </select>
      </label>

      {!configured ? (
        <p className="text-xs text-amber-600">
          Model catalog is not configured. Free-text input is allowed, but the model may be rejected by the gateway.
        </p>
      ) : null}

      {selected ? (
        <div className="rounded border bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
          <div className="flex flex-wrap gap-2">
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">{selected.protocol}</span>
            {selected.contextLength ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">
                {formatTokens(selected.contextLength)} context
              </span>
            ) : null}
            {selected.supportsVision ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">vision</span>
            ) : null}
            {selected.supportsFunctionCalling ? (
              <span className="rounded bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">tools</span>
            ) : null}
          </div>
          {selected.inputPrice != null || selected.outputPrice != null ? (
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              ${formatPrice(selected.inputPrice)}/1M in · ${formatPrice(selected.outputPrice)}/1M out
            </p>
          ) : null}
          {!selected.isAvailable ? (
            <p className="mt-1 text-red-600">{selected.unavailableReason ?? "Unavailable"}</p>
          ) : null}
        </div>
      ) : value ? (
        <p className="text-xs text-neutral-500">
          Selected model “{value}” is not in the {formatDaemonProviderLabel(provider)} catalog; it may be rejected if incompatible.
        </p>
      ) : null}

      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatPrice(value: number | null | undefined): string {
  if (value == null) return "-";
  return value.toFixed(4);
}
