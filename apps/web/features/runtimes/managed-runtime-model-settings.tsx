"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  getManagedRuntimeModelsAction,
  updateManagedRuntimeDefaultModelAction,
} from "@/features/runtimes/actions";
import { ModelCatalogSelect, type ModelCatalogOption } from "@/features/runtimes/runtime-model-picker";

type RuntimeModelOption = ModelCatalogOption & {
  modelType?: string | null;
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
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getManagedRuntimeModelsAction(runtimeId)
      .then((result) => {
        if (!active) return;
        setModels(result.list);
        setConfigured(result.configured);
      })
      .catch(() => {
        if (!active) return;
        setModels([]);
        setConfigured(false);
        setError("The model catalog could not be loaded. Check the models service and try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [reloadKey, runtimeId]);

  const availableModels = models.filter(
    (model) => model.modelType === "llm" && model.alias && model.isAvailable && model.isEnabled !== false,
  );
  const changed = value !== (defaultModel ?? "");
  const unavailable = loading || pending || !configured;

  return (
    <form
      className="runtime-model-setting"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || unavailable) return;
        setError(null);
        startTransition(async () => {
          try {
            await updateManagedRuntimeDefaultModelAction({ runtimeId, defaultModel: value || undefined });
            router.refresh();
          } catch {
            setError("The selected model is no longer available for this runtime. Refresh the catalog and choose another model.");
          }
        });
      }}
    >
      <div className="runtime-model-setting__copy">
        <strong>Default model</strong>
        <small>Used when an AI employee and conversation do not set a model.</small>
      </div>
      <div className="runtime-model-setting__field">
        <ModelCatalogSelect
          disabled={unavailable}
          label="Default model"
          loading={loading}
          onChange={setValue}
          options={availableModels}
          value={value}
        />
      </div>
      <button type="submit" className="action-button runtime-model-setting__save" disabled={!changed || unavailable}>
        {pending ? "Saving" : "Save model"}
      </button>
      {!configured && !error ? <p className="runtime-model-setting__notice">Connect the models service to configure a runtime default.</p> : null}
      {error ? (
        <div className="runtime-model-setting__error" role="alert">
          <p>{error}</p>
          <button
            className="runtime-model-setting__retry"
            disabled={loading || pending}
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            Retry catalog
          </button>
        </div>
      ) : null}
    </form>
  );
}
