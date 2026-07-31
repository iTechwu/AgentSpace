"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import {
  getChatModelOverrideAction,
  setChatModelOverrideAction,
} from "@/features/channels/actions";
import {
  listProtocolFilteredRuntimeModelsAction,
  type RuntimeModelCatalogItem,
} from "@/features/runtimes/actions";
import { AppIcon } from "@/shared/ui/app-icon";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import type { DaemonProvider } from "@dofe-agent/domain";

export interface ChatModelSelectorProps {
  /** Direct-contact agent id. */
  contactId?: string;
  /** Group channel name (requires `content` with a single agent mention). */
  channelName?: string;
  /** Message content used to pick the agent in a group channel. */
  content?: string;
  /** The direct-chat name shown in the conversation header. */
  displayName?: string;
  /** Whether the current user is allowed to change the session override. */
  canManage: boolean;
}

export interface ChatModelCommandDialogProps {
  contactId?: string;
  channelName?: string;
  content?: string;
  displayName: string;
  onClose: () => void;
  onChanged?: () => void;
}

interface ModelOverrideInfo {
  routerSessionId: string;
  agentName: string;
  sessionOverride?: { modelId: string; source: string };
  effectiveModel?: {
    modelId: string;
    source:
      | "session_override"
      | "employee_default"
      | "skill_requirement"
      | "runtime_default"
      | "team_policy_default"
      | "protocol_fallback";
  };
  provider?: DaemonProvider;
}

export function ChatModelSelector({
  contactId,
  channelName,
  content,
  displayName,
  canManage,
}: ChatModelSelectorProps) {
  const { tx } = useLanguage();
  const [info, setInfo] = useState<ModelOverrideInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const fetchInfo = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    getChatModelOverrideAction({
      contactId,
      channelName,
      content,
    })
      .then((result) => {
        if (!cancelled) {
          setInfo(result);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setInfo(null);
          setError({
            code: "load_failed",
            message: reason instanceof Error ? reason.message : tx("模型信息加载失败。", "Failed to load model information."),
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, channelName, content, tx]);

  useEffect(() => {
    return fetchInfo();
  }, [fetchInfo]);

  const activeModel = info?.effectiveModel ?? info?.sessionOverride;
  const sessionValue = info?.sessionOverride?.modelId ?? "";

  const handleChange = (value: string) => {
    if (!info) return;
    setError(null);
    startTransition(async () => {
      const result = await setChatModelOverrideAction({
        contactId,
        channelName,
        content,
        modelId: value || undefined,
      });
      if (!result.ok) {
        setError({ code: result.code, message: result.message });
      } else {
        setError(null);
        fetchInfo();
      }
    });
  };

  if (loading) {
    return (
      <span className="chat-model-selector chat-model-selector--loading">
        <span className="chat-model-selector__trigger">
          <span className="chat-model-selector__value">{displayName ?? tx("加载中…", "Loading…")}</span>
        </span>
      </span>
    );
  }

  if (!info) {
    return (
      <span className="chat-model-selector" title={error?.message}>
        <span className="chat-model-selector__trigger">
          <span className="chat-model-selector__value chat-model-selector__value--empty">
            {displayName ?? tx("模型不可用", "Model unavailable")}
          </span>
        </span>
        {error ? (
          <span className="chat-model-selector__error" title={error.message}>
            {errorLabel(error.code, tx)}
          </span>
        ) : null}
      </span>
    );
  }

  const provider = info.provider;
  const canPick = canManage && provider != null;
  const modelDisplay = formatModelDisplay(displayName ?? info.agentName, activeModel?.modelId, tx);

  return (
    <span
      className={`chat-model-selector${canPick ? " chat-model-selector--interactive" : ""}`}
      title={modelDisplay}
    >
      <span className="chat-model-selector__trigger">
        {activeModel ? (
          <span className="chat-model-selector__value" title={modelDisplay}>
            {modelDisplay}
          </span>
        ) : (
          <span className="chat-model-selector__value chat-model-selector__value--empty" title={modelDisplay}>
            {modelDisplay}
          </span>
        )}
        {canPick ? <AppIcon className="chat-model-selector__chevron" name="chevronDown" /> : null}
      </span>
      {canPick ? (
        <CompactModelPicker
          pending={pending}
          provider={provider}
          value={sessionValue}
          onChange={handleChange}
        />
      ) : null}
      {error ? (
        <span className="chat-model-selector__error" title={error.message}>
          {errorLabel(error.code, tx)}
        </span>
      ) : null}
    </span>
  );
}

export function ChatModelCommandDialog({
  contactId,
  channelName,
  content,
  displayName,
  onClose,
  onChanged,
}: ChatModelCommandDialogProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLDivElement>(onClose);
  const [info, setInfo] = useState<ModelOverrideInfo | null>(null);
  const [items, setItems] = useState<RuntimeModelCatalogItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getChatModelOverrideAction({ contactId, channelName, content })
      .then(async (result) => {
        if (cancelled) return;
        setInfo(result);
        if (!result?.provider) {
          setConfigured(false);
          setItems([]);
          return;
        }
        const catalog = await listProtocolFilteredRuntimeModelsAction(result.provider);
        if (cancelled) return;
        setConfigured(catalog.configured);
        setItems(catalog.list.filter((item) => item.isAvailable));
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : tx("模型列表加载失败。", "Failed to load models."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelName, contactId, content, tx]);

  const selectedModelId = info?.sessionOverride?.modelId ?? "";

  function selectModel(modelId: string): void {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await setChatModelOverrideAction({
          contactId,
          channelName,
          content,
          modelId: modelId || undefined,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onChanged?.();
        onClose();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : tx("模型切换失败。", "Failed to switch model."));
      }
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <div
        aria-labelledby={labelId}
        aria-modal="true"
        className="modal-card modal-card--compact chat-model-command-dialog"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("切换模型", "Switch model")}</h3>
            <p>{tx(`为 ${displayName} 的当前会话选择模型`, `Choose a model for ${displayName}'s current conversation`)}</p>
          </div>
          <button
            aria-label={tx("关闭模型选择", "Close model picker")}
            className="modal-close"
            onClick={onClose}
            type="button"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body chat-model-command-dialog__body">
          {loading ? (
            <div className="chat-model-command-dialog__state">
              <AppIcon name="loader" />
              <span>{tx("正在加载可用模型…", "Loading available models…")}</span>
            </div>
          ) : error ? (
            <div className="chat-model-command-dialog__state chat-model-command-dialog__state--error" role="alert">
              <AppIcon name="alertCircle" />
              <span>{error}</span>
            </div>
          ) : !configured || !info?.provider ? (
            <div className="chat-model-command-dialog__state">
              <AppIcon name="info" />
              <span>{tx("该员工尚未配置可切换的受管模型。", "This employee has no managed models available to switch.")}</span>
            </div>
          ) : (
            <div aria-label={tx("可用模型", "Available models")} className="chat-model-command-dialog__list" role="listbox">
              <ModelCommandOption
                description={tx("使用员工或 Runtime 的默认模型", "Use the employee or Runtime default")}
                label={tx("继承默认", "Inherit default")}
                pending={pending}
                selected={selectedModelId === ""}
                onSelect={() => selectModel("")}
              />
              {items.map((item) => (
                <ModelCommandOption
                  description={item.alias}
                  key={item.alias}
                  label={item.displayName ?? item.alias}
                  pending={pending}
                  selected={selectedModelId === item.alias}
                  onSelect={() => selectModel(item.alias)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelCommandOption({
  label,
  description,
  selected,
  pending,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-selected={selected}
      className={`chat-model-command-dialog__option${selected ? " chat-model-command-dialog__option--selected" : ""}`}
      disabled={pending}
      onClick={onSelect}
      role="option"
      type="button"
    >
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      {selected ? <AppIcon name="checkCircle" /> : null}
    </button>
  );
}

function formatModelDisplay(
  agentName: string,
  modelId: string | undefined,
  tx: (zh: string, en: string) => string,
): string {
  return modelId
    ? tx(`${agentName}（${modelId}）`, `${agentName} (${modelId})`)
    : tx(`${agentName}（未配置）`, `${agentName} (Not set)`);
}

function CompactModelPicker({
  provider,
  value,
  onChange,
  pending,
}: {
  provider: DaemonProvider;
  value: string;
  onChange: (value: string) => void;
  pending: boolean;
}) {
  const { tx } = useLanguage();
  const [items, setItems] = useState<RuntimeModelCatalogItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    listProtocolFilteredRuntimeModelsAction(provider)
      .then((result) => {
        setConfigured(result.configured);
        setItems(result.list.filter((item) => item.isAvailable));
      })
      .catch(() => {
        setConfigured(false);
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [provider]);

  return (
    <select
      className="chat-model-selector__select"
      disabled={pending || loading || !configured}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">{tx("继承默认", "Inherit default")}</option>
      {items.map((item) => (
        <option key={item.alias} value={item.alias}>
          {item.displayName ?? item.alias}
        </option>
      ))}
    </select>
  );
}

function errorLabel(
  code: string,
  tx: (zh: string, en: string) => string,
): string {
  switch (code) {
    case "model_unavailable":
      return tx("该模型不可用", "Model unavailable");
    case "no_bound_runtime":
      return tx("AI员工未绑定 Runtime", "No bound runtime");
    case "not_a_managed_runtime":
      return tx("绑定 Runtime 非受管", "Not a managed runtime");
    case "remote_mode_required":
      return tx("仅 remote 模式可用", "Remote mode required");
    case "model_required":
      return tx("需要模型 ID", "Model id required");
    case "load_failed":
      return tx("模型加载失败", "Failed to load model");
    default:
      return tx("设置失败", "Failed to set model");
  }
}
