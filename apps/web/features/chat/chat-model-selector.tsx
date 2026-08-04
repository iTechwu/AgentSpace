"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import {
  getChatModelOverrideAction,
  setChatModelOverrideAction,
} from "@/features/channels/actions";
import {
  listProtocolFilteredRuntimeModelsAction,
  type RuntimeModelCatalogItem,
} from "@/features/runtimes/actions";
import { translateUnavailableReason } from "@/features/runtimes/runtime-model-picker";
import { AppIcon } from "@/shared/ui/app-icon";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { formatDaemonProviderLabel, type DaemonProvider } from "@dofe-agent/domain";

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
  /**
   * AI 员工在设置页配置的默认模型 ID。传递后首帧即可渲染
   * "员工名（模型名）"，无需等待 server action 返回。
   */
  initialModelId?: string;
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
  initialModelId,
}: ChatModelSelectorProps) {
  const { tx } = useLanguage();
  const [info, setInfo] = useState<ModelOverrideInfo | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  // 跟踪首次 fetch 是否完成——未完成时不显示 error 状态避免闪烁
  const [initialFetchDone, setInitialFetchDone] = useState(false);

  const fetchInfo = useCallback(() => {
    let cancelled = false;
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
          setInitialFetchDone(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, channelName, content, tx]);

  useEffect(() => {
    return fetchInfo();
  }, [fetchInfo]);

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

  // 始终渲染同一结构，消除加载状态导致的模型名闪烁。
  // info 未就绪时用 initialModelId 或 displayName 作为占位文案。
  const activeModel = info?.effectiveModel ?? info?.sessionOverride;
  const sessionValue = info?.sessionOverride?.modelId ?? "";
  const provider = info?.provider;
  const canPick = canManage && provider != null;
  const effectiveDisplayName = displayName ?? info?.agentName ?? "";
  const modelDisplay = info
    ? formatModelDisplay(effectiveDisplayName, activeModel?.modelId, Boolean(info.provider), tx)
    : initialModelId
      ? formatModelDisplay(displayName ?? "", initialModelId, false, tx)
      : displayName ?? "";

  return (
    <span
      className={`chat-model-selector${canPick ? " chat-model-selector--interactive" : ""}${!info ? " chat-model-selector--pending" : ""}`}
      title={modelDisplay}
    >
      <span className="chat-model-selector__trigger">
        <span
          className={`chat-model-selector__value${!info || !activeModel ? " chat-model-selector__value--empty" : ""}`}
          title={modelDisplay}
        >
          {modelDisplay || tx("加载中…", "Loading…")}
        </span>
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
      {error && initialFetchDone ? (
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
  const [query, setQuery] = useState("");

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
        setItems(catalog.list);
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
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = useMemo(() => items.filter((item) => {
    if (!normalizedQuery) return true;
    return [item.displayName, item.alias, item.model, item.protocol, item.unavailableReason]
      .some((value) => value?.toLowerCase().includes(normalizedQuery));
  }), [items, normalizedQuery]);
  const availableItems = visibleItems.filter((item) => item.isAvailable);
  const unavailableItems = visibleItems.filter((item) => !item.isAvailable);
  const totalAvailable = items.filter((item) => item.isAvailable).length;

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
            <div className="chat-model-command-dialog__catalog">
              <div className="chat-model-command-dialog__summary">
                <span>{formatDaemonProviderLabel(info.provider)}</span>
                <span>{tx(`${totalAvailable} 个可切换模型`, `${totalAvailable} switchable models`)}</span>
              </div>

              {totalAvailable === 0 ? (
                <div className="chat-model-command-dialog__notice" role="status">
                  <AppIcon name="info" />
                  <span>
                    <strong>{tx("暂无可用模型", "No available models yet")}</strong>
                    <small>{tx("当前执行引擎没有可用的协议兼容模型，请联系管理员配置。", "The current runtime has no protocol-compatible models available. Contact an administrator to configure one.")}</small>
                  </span>
                </div>
              ) : null}

              <label className="chat-model-command-dialog__search">
                <AppIcon name="search" />
                <span className="sr-only">{tx("搜索模型", "Search models")}</span>
                <input
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tx("搜索模型名称或别名", "Search model name or alias")}
                  type="search"
                  value={query}
                />
                <button
                  aria-hidden={!query}
                  aria-label={tx("清除搜索", "Clear search")}
                  className={query ? "chat-model-command-dialog__search-clear--visible" : undefined}
                  disabled={!query}
                  onClick={() => setQuery("")}
                  tabIndex={query ? 0 : -1}
                  type="button"
                >
                  <AppIcon name="close" />
                </button>
              </label>

              <div aria-label={tx("模型列表", "Model list")} className="chat-model-command-dialog__list" role="listbox">
                {!normalizedQuery ? (
                  <div aria-label={tx("会话默认", "Conversation default")} className="chat-model-command-dialog__group" role="group">
                    <ModelCommandOption
                      description={tx("使用员工或 Runtime 的默认模型", "Use the employee or Runtime default")}
                      label={tx("继承默认", "Inherit default")}
                      pending={pending}
                      selected={selectedModelId === ""}
                      onSelect={() => selectModel("")}
                    />
                  </div>
                ) : null}

                {availableItems.length > 0 ? (
                  <div aria-label={tx("可用模型", "Available models")} className="chat-model-command-dialog__group" role="group">
                    <p className="chat-model-command-dialog__group-title">
                      {tx("可用模型", "Available")}
                      <span>{availableItems.length}</span>
                    </p>
                    {availableItems.map((item) => (
                      <ModelCommandOption
                        description={modelOptionDescription(item)}
                        key={item.alias}
                        label={item.displayName ?? item.alias}
                        pending={pending}
                        selected={selectedModelId === item.alias || selectedModelId === item.model}
                        onSelect={() => selectModel(item.alias)}
                      />
                    ))}
                  </div>
                ) : null}

                {unavailableItems.length > 0 ? (
                  <div aria-label={tx("暂不可用模型", "Unavailable models")} className="chat-model-command-dialog__group" role="group">
                    <p className="chat-model-command-dialog__group-title">
                      {tx("暂不可用", "Unavailable")}
                      <span>{unavailableItems.length}</span>
                    </p>
                    {unavailableItems.map((item) => (
                      <ModelCommandOption
                        description={modelOptionDescription(item)}
                        key={item.alias}
                        label={item.displayName ?? item.alias}
                        pending={pending}
                        selected={selectedModelId === item.alias || selectedModelId === item.model}
                        unavailableReason={translateUnavailableReason(item.unavailableReason, tx)}
                        onSelect={() => undefined}
                      />
                    ))}
                  </div>
                ) : null}

                {normalizedQuery && visibleItems.length === 0 ? (
                  <div className="chat-model-command-dialog__empty">
                    <AppIcon name="search" />
                    <span>{tx(`没有找到“${query.trim()}”`, `No models found for “${query.trim()}”`)}</span>
                  </div>
                ) : null}
              </div>
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
  unavailableReason,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  pending: boolean;
  unavailableReason?: string;
  onSelect: () => void;
}) {
  const disabled = pending || Boolean(unavailableReason);
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-label={[label, description, unavailableReason].filter(Boolean).join(" · ")}
      aria-selected={selected}
      className={`chat-model-command-dialog__option${selected ? " chat-model-command-dialog__option--selected" : ""}${unavailableReason ? " chat-model-command-dialog__option--disabled" : ""}`}
      disabled={disabled}
      onClick={onSelect}
      role="option"
      type="button"
    >
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      {unavailableReason ? <em>{unavailableReason}</em> : selected ? <AppIcon name="checkCircle" /> : null}
    </button>
  );
}

function modelOptionDescription(item: RuntimeModelCatalogItem): string | undefined {
  const identity = item.displayName && item.displayName !== item.alias ? item.alias : undefined;
  const metadata = [
    item.protocol,
    item.contextLength ? formatContextLength(item.contextLength) : undefined,
  ].filter(Boolean).join(" · ");
  return [identity, metadata].filter(Boolean).join(" · ") || undefined;
}

function formatContextLength(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatModelDisplay(
  agentName: string,
  modelId: string | undefined,
  inheritsRuntimeDefault: boolean,
  tx: (zh: string, en: string) => string,
): string {
  if (modelId) {
    return tx(`${agentName}（${modelId}）`, `${agentName} (${modelId})`);
  }
  return inheritsRuntimeDefault
    ? tx(`${agentName}（Runtime 默认）`, `${agentName} (Runtime default)`)
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
