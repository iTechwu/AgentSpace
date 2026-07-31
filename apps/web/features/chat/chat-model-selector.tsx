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
import type { DaemonProvider } from "@dofe-agent/domain";

export interface ChatModelSelectorProps {
  /** Direct-contact agent id. */
  contactId?: string;
  /** Group channel name (requires `content` with a single agent mention). */
  channelName?: string;
  /** Message content used to pick the agent in a group channel. */
  content?: string;
  /** Whether the current user is allowed to change the session override. */
  canManage: boolean;
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
  }, [contactId, channelName, content]);

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

  if (!info || loading) {
    return (
      <div className="chat-model-selector chat-model-selector--loading">
        <span className="chat-model-selector__trigger">
          <span className="chat-model-selector__label">{tx("模型", "Model")}</span>
          <span className="chat-model-selector__value">{tx("加载中…", "Loading…")}</span>
        </span>
      </div>
    );
  }

  const provider = info.provider;
  const canPick = canManage && provider != null;

  return (
    <div
      className={`chat-model-selector${canPick ? " chat-model-selector--interactive" : ""}`}
      title={sourceLabel(activeModel?.source, tx)}
    >
      <div className="chat-model-selector__trigger">
        <span className="chat-model-selector__label">{tx("模型", "Model")}</span>
        {activeModel ? (
          <span className="chat-model-selector__value" title={activeModel.modelId}>
            {activeModel.modelId}
          </span>
        ) : (
          <span className="chat-model-selector__value chat-model-selector__value--empty">
            {tx("未配置", "Not set")}
          </span>
        )}
        {activeModel ? (
          <span
            className={`chat-model-selector__source chat-model-selector__source--${activeModel.source}`}
          >
            {sourceLabel(activeModel.source, tx)}
          </span>
        ) : null}
        {canPick ? <AppIcon className="chat-model-selector__chevron" name="chevronDown" /> : null}
      </div>
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
    </div>
  );
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

function sourceLabel(
  source: string | undefined,
  tx: (zh: string, en: string) => string,
): string {
  switch (source) {
    case "session_override":
    case "manual":
      return tx("会话覆盖", "Session override");
    case "employee_default":
      return tx("AI员工默认", "Employee default");
    case "runtime_default":
      return tx("Runtime 默认", "Runtime default");
    case "team_policy_default":
      return tx("团队策略", "Team policy");
    case "protocol_fallback":
      return tx("协议兜底", "Protocol fallback");
    default:
      return tx("未配置", "Not set");
  }
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
    default:
      return tx("设置失败", "Failed to set model");
  }
}
