"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listProtocolFilteredRuntimeModelsAction,
  type RuntimeModelCatalogItem,
} from "@/features/runtimes/actions";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { DaemonProvider } from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";

export interface RuntimeModelPickerProps {
  provider: DaemonProvider;
  value: string;
  onChange: (value: string) => void;
}

export function RuntimeModelPicker({ provider, value, onChange }: RuntimeModelPickerProps) {
  const { tx } = useLanguage();
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<RuntimeModelCatalogItem[]>([]);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setError(null);
    setQuery("");
    startTransition(async () => {
      try {
        const result = await listProtocolFilteredRuntimeModelsAction(provider);
        setConfigured(result.configured);
        setItems(result.list);
      } catch {
        setError(tx("无法加载模型目录。", "Model catalog could not be loaded."));
        setItems([]);
      }
    });
  }, [provider, tx]);

  const selected = items.find((item) => item.alias === value || item.model === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = items.filter((item) =>
    item.modelType === "llm" &&
      (!normalizedQuery
        || item.alias === value
        || [item.alias, item.displayName, item.model, item.protocol].some((field) => field?.toLowerCase().includes(normalizedQuery))),
  );
  const selectedLlm = selected?.modelType === "llm" ? selected : undefined;
  return (
    <div className="runtime-model-picker">
      <label className="runtime-field">
        <span>{tx("搜索模型", "Search models")}</span>
        <input type="search" value={query} disabled={pending || !configured} onChange={(event) => setQuery(event.target.value)} placeholder={tx("名称、别名或协议", "Name, alias, or protocol")} />
      </label>
      <label className="runtime-field">
        <span>{tx("默认模型", "Default model")}</span>
        <select
          value={value}
          disabled={pending || !configured}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{pending ? tx("正在加载模型...", "Loading models...") : tx("跟随系统默认", "Inherit system fallback")}</option>
          {filteredItems.map((item) => (
            <option key={item.alias} value={item.alias} disabled={!item.isAvailable}>
              {formatModelOption(item, tx)}
            </option>
          ))}
        </select>
      </label>

      {!configured ? (
        <p className="runtime-model-picker__warning">
          {tx("模型目录尚未配置，连接模型服务后才能创建执行引擎。", "Model catalog is not configured. Runtime creation is unavailable until it is connected.")}
        </p>
      ) : null}

      {selectedLlm ? (
        <div className="runtime-model-picker__summary">
          <div className="runtime-model-picker__tags">
            <span>{selectedLlm.protocol}</span>
            {selectedLlm.contextLength ? (
              <span>
                {formatTokens(selectedLlm.contextLength)} {tx("上下文", "context")}
              </span>
            ) : null}
            {selectedLlm.supportsVision ? (
              <span>{tx("视觉", "vision")}</span>
            ) : null}
            {selectedLlm.supportsFunctionCalling ? (
              <span>{tx("工具调用", "tools")}</span>
            ) : null}
          </div>
          {selectedLlm.inputPrice != null || selectedLlm.outputPrice != null ? (
            <p>
              ¥{formatPrice(selectedLlm.inputPrice)}/1M {tx("输入", "in")} · ¥{formatPrice(selectedLlm.outputPrice)}/1M {tx("输出", "out")}
            </p>
          ) : null}
          {!selectedLlm.isAvailable ? (
            <p className="runtime-model-picker__error">{translateUnavailableReason(selectedLlm.unavailableReason, tx)}</p>
          ) : null}
        </div>
      ) : value ? (
        <p className="runtime-model-picker__hint">
          {tx(
            `所选模型“${value}”不在 ${formatDaemonProviderLabel(provider)} 目录中；若不兼容，请求可能被拒绝。`,
            `Selected model “${value}” is not in the ${formatDaemonProviderLabel(provider)} catalog; it may be rejected if incompatible.`,
          )}
        </p>
      ) : null}

      {error ? <p className="runtime-model-picker__error">{error}</p> : null}
    </div>
  );
}

function formatModelOption(item: RuntimeModelCatalogItem, tx: (zh: string, en: string) => string): string {
  const capabilities = [
    item.protocol,
    item.contextLength ? `${formatTokens(item.contextLength)} ${tx("上下文", "context")}` : undefined,
    item.supportsFunctionCalling ? tx("工具调用", "tools") : undefined,
    item.supportsVision ? tx("视觉", "vision") : undefined,
    item.inputPrice != null || item.outputPrice != null
      ? `¥${formatPrice(item.inputPrice)}/¥${formatPrice(item.outputPrice)} ${tx("每百万", "per 1M")}`
      : undefined,
  ].filter(Boolean).join(" · ");
  const availability = item.isAvailable ? tx("可用", "available") : translateUnavailableReason(item.unavailableReason, tx);
  return `${item.displayName ?? item.alias} · ${capabilities} · ${availability}`;
}

function translateUnavailableReason(reason: string | undefined, tx: (zh: string, en: string) => string): string {
  if (!reason) return tx("不可用", "Unavailable");
  const protocolMatch = reason.match(/^Runtime protocol \((.+)\) not supported$/);
  if (protocolMatch?.[1]) {
    return tx(`不支持执行引擎协议（${protocolMatch[1]}）`, reason);
  }
  if (reason === "Disabled by team policy") {
    return tx("已被团队策略禁用", reason);
  }
  return reason;
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
