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
  const [catalogState, setCatalogState] = useState<"ready" | "not_configured" | "credential_missing" | "unavailable">("ready");
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
        setCatalogState(result.catalogState);
      })
      .catch(() => {
        if (!active) return;
        setModels([]);
        setConfigured(false);
        setCatalogState("unavailable");
        setError("无法加载模型目录，请检查模型服务后重试。");
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
            setError("所选模型已不适用于当前执行引擎，请刷新目录后重新选择。");
          }
        });
      }}
    >
      <div className="runtime-model-setting__copy">
        <strong>默认模型</strong>
        <small>当 AI 员工或会话未指定模型时，使用此设置。</small>
      </div>
      <div className="runtime-model-setting__field">
        <ModelCatalogSelect
          disabled={unavailable}
          label="默认模型"
          labels={{
            fallback: "跟随系统默认",
            loading: "正在加载模型...",
            search: "搜索模型",
            searchPlaceholder: "搜索模型、别名或供应商...",
            empty: "没有匹配的模型",
            resultCount: (count) => `可用模型 ${count} 个`,
            context: "上下文",
            tools: "工具调用",
            vision: "视觉",
            perMillion: "每百万 Token",
            available: "可用",
            unavailable: (reason) => reason || "不可用",
          }}
          loading={loading}
          onChange={setValue}
          options={availableModels}
          value={value}
        />
      </div>
      <button type="submit" className="action-button runtime-model-setting__save" disabled={!changed || unavailable}>
        {pending ? "保存中" : "保存模型"}
      </button>
      {!configured && !error ? <p className="runtime-model-setting__notice">{catalogNotice(catalogState)}</p> : null}
      {error ? (
        <div className="runtime-model-setting__error" role="alert">
          <p>{error}</p>
          <button
            className="runtime-model-setting__retry"
            disabled={loading || pending}
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载
          </button>
        </div>
      ) : null}
    </form>
  );
}

function catalogNotice(state: "ready" | "not_configured" | "credential_missing" | "unavailable"): string {
  if (state === "credential_missing") return "此执行引擎的模型凭据需要恢复或重新部署后，才能设置默认模型。";
  if (state === "not_configured") return "连接模型服务后即可设置执行引擎的默认模型。";
  return "模型目录暂时不可用，请稍后重试。";
}
