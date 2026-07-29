"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  getManagedRuntimeModelsAction,
  updateManagedRuntimeDefaultModelAction,
} from "@/features/runtimes/actions";

type RuntimeModelOption = {
  id: string;
  alias?: string | null;
  model?: string | null;
  displayName?: string | null;
  isAvailable?: boolean | null;
  isEnabled?: boolean | null;
};

export function ManagedRuntimeModelSettings({
  runtimeId,
  defaultModel,
}: {
  runtimeId: string;
  defaultModel?: string;
}) {
  const router = useRouter();
  const [models, setModels] = useState<RuntimeModelOption[]>([]);
  const [configured, setConfigured] = useState(true);
  const [value, setValue] = useState(defaultModel ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    void getManagedRuntimeModelsAction(runtimeId)
      .then((result) => {
        if (!active) return;
        setModels(result.list);
        setConfigured(result.configured);
      })
      .catch(() => {
        if (active) setError("The model catalog could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [runtimeId]);

  const availableModels = models.filter((model) => model.alias && model.isAvailable && model.isEnabled !== false);
  const changed = value !== (defaultModel ?? "");

  return (
    <form
      className="runtime-model-setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed) return;
        setError(null);
        startTransition(async () => {
          try {
            await updateManagedRuntimeDefaultModelAction({ runtimeId, defaultModel: value || undefined });
            router.refresh();
          } catch {
            setError("The selected model is no longer available for this runtime.");
          }
        });
      }}
    >
      <div className="runtime-model-setting__copy">
        <strong>Default model</strong>
        <small>Used when an AI employee and conversation do not set a model.</small>
      </div>
      <label className="runtime-model-setting__field">
        <span className="sr-only">Default model</span>
        <select value={value} disabled={loading || pending || !configured} onChange={(event) => setValue(event.target.value)}>
          <option value="">System fallback</option>
          {availableModels.map((model) => (
            <option key={model.id} value={model.alias!}>
              {model.displayName || model.alias}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="action-button runtime-model-setting__save" disabled={!changed || loading || pending || !configured}>
        {pending ? "Saving" : "Save model"}
      </button>
      {!configured ? <p className="runtime-model-setting__notice">Connect the models service to configure a runtime default.</p> : null}
      {error ? <p className="runtime-model-setting__error" role="alert">{error}</p> : null}
    </form>
  );
}
