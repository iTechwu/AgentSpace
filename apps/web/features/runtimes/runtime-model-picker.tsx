"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  listProtocolFilteredRuntimeModelsAction,
  type RuntimeModelCatalogItem,
} from "@/features/runtimes/actions";
import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { DaemonProvider } from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";

export interface ModelCatalogOption {
  id?: string;
  alias: string;
  displayName?: string | null;
  model?: string | null;
  protocol?: string | null;
  contextLength?: number | null;
  supportsVision?: boolean | null;
  supportsFunctionCalling?: boolean | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  isAvailable?: boolean | null;
  unavailableReason?: string;
}

interface ModelCatalogSelectLabels {
  fallback: string;
  loading: string;
  search: string;
  searchPlaceholder: string;
  empty: string;
  resultCount: (count: number) => string;
  context: string;
  tools: string;
  vision: string;
  perMillion: string;
  available: string;
  unavailable: (reason?: string) => string;
}

export interface ModelCatalogSelectProps {
  label: string;
  value: string;
  options: ModelCatalogOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  labels?: Partial<ModelCatalogSelectLabels>;
}

const defaultLabels: ModelCatalogSelectLabels = {
  fallback: "System fallback",
  loading: "Loading models...",
  search: "Search models",
  searchPlaceholder: "Search models, aliases, or providers...",
  empty: "No matching models",
  resultCount: (count) => `${count} models available`,
  context: "context",
  tools: "tools",
  vision: "vision",
  perMillion: "per 1M",
  available: "Available",
  unavailable: (reason) => reason || "Unavailable",
};

/**
 * A fixed-height, searchable model menu used for every runtime model choice.
 * The menu is absolutely positioned so opening or loading it never moves the page.
 */
export function ModelCatalogSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  labels,
}: ModelCatalogSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const text = { ...defaultLabels, ...labels };
  const selected = options.find((option) => option.alias === value || option.model === value);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = options.filter((option) =>
    !normalizedQuery || [option.alias, option.displayName, option.model, option.protocol]
      .some((field) => field?.toLowerCase().includes(normalizedQuery)),
  );

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled || loading) setOpen(false);
  }, [disabled, loading]);

  const triggerTitle = loading
    ? text.loading
    : selected?.displayName || selected?.alias || value || text.fallback;

  return (
    <div className="model-catalog-select" ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className={`model-catalog-select__trigger${open ? " model-catalog-select__trigger--open" : ""}`}
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        type="button"
      >
        <span className="model-catalog-select__trigger-copy">
          <strong>{triggerTitle}</strong>
          <span>{selected ? formatModelMeta(selected, text) : text.fallback}</span>
        </span>
        <AppIcon className="model-catalog-select__chevron" name="chevronDown" />
      </button>

      {open ? (
        <div aria-label={label} className="model-catalog-select__menu" id={menuId} role="listbox">
          <label className="model-catalog-select__search">
            <AppIcon name="search" />
            <span className="sr-only">{text.search}</span>
            <input
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text.searchPlaceholder}
              type="search"
              value={query}
            />
          </label>
          <p className="model-catalog-select__count">{text.resultCount(visibleOptions.length)}</p>
          <div className="model-catalog-select__options">
            <button
              aria-selected={!value}
              className={`model-catalog-select__option${!value ? " model-catalog-select__option--selected" : ""}`}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <strong>{text.fallback}</strong>
              <span>{text.fallback}</span>
            </button>
            {visibleOptions.map((option) => {
              const unavailable = option.isAvailable === false;
              const optionName = option.displayName || option.alias;
              return (
                <button
                  aria-disabled={unavailable || undefined}
                  aria-label={`${optionName} · ${formatModelMeta(option, text)} · ${unavailable ? text.unavailable(option.unavailableReason) : text.available}`}
                  aria-selected={option.alias === value || option.model === value}
                  className={`model-catalog-select__option${option.alias === value || option.model === value ? " model-catalog-select__option--selected" : ""}${unavailable ? " model-catalog-select__option--disabled" : ""}`}
                  disabled={unavailable}
                  key={option.id ?? option.alias}
                  onClick={() => {
                    onChange(option.alias);
                    setOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <span className="model-catalog-select__option-title">
                    <strong>{optionName}</strong>
                    {unavailable ? <em>{text.unavailable(option.unavailableReason)}</em> : <em>{text.available}</em>}
                  </span>
                  <span>{option.model || option.alias}</span>
                  <span>{formatModelMeta(option, text)}</span>
                </button>
              );
            })}
            {visibleOptions.length === 0 ? <p className="model-catalog-select__empty">{text.empty}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

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

  useEffect(() => {
    setError(null);
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
  const llmItems = items.filter((item) => item.modelType === "llm");
  const selectedLlm = selected?.modelType === "llm" ? selected : undefined;
  const labels: Partial<ModelCatalogSelectLabels> = {
    fallback: tx("跟随系统默认", "Inherit system fallback"),
    loading: tx("正在加载模型...", "Loading models..."),
    search: tx("搜索模型", "Search models"),
    searchPlaceholder: tx("搜索模型、别名或供应商...", "Search models, aliases, or providers..."),
    empty: tx("没有匹配的模型", "No matching models"),
    resultCount: (count) => tx(`当前协议支持 ${count} 个模型`, `${count} models supported by this protocol`),
    context: tx("上下文", "context"),
    tools: tx("工具调用", "tools"),
    vision: tx("视觉", "vision"),
    perMillion: tx("每百万", "per 1M"),
    available: tx("可用", "Available"),
    unavailable: (reason) => translateUnavailableReason(reason, tx),
  };

  return (
    <div className="runtime-model-picker">
      <div className="runtime-field">
        <span>{tx("默认模型", "Default model")}</span>
        <ModelCatalogSelect
          disabled={!configured}
          label={tx("默认模型", "Default model")}
          labels={labels}
          loading={pending}
          onChange={onChange}
          options={llmItems}
          value={value}
        />
      </div>

      {!configured ? (
        <p className="runtime-model-picker__warning">
          {tx("模型目录尚未配置，连接模型服务后才能创建执行引擎。", "Model catalog is not configured. Runtime creation is unavailable until it is connected.")}
        </p>
      ) : null}

      {selectedLlm ? (
        <div className="runtime-model-picker__summary">
          <div className="runtime-model-picker__tags">
            <span>{selectedLlm.protocol}</span>
            {selectedLlm.contextLength ? <span>{formatTokens(selectedLlm.contextLength)} {tx("上下文", "context")}</span> : null}
            {selectedLlm.supportsVision ? <span>{tx("视觉", "vision")}</span> : null}
            {selectedLlm.supportsFunctionCalling ? <span>{tx("工具调用", "tools")}</span> : null}
          </div>
          {selectedLlm.inputPrice != null || selectedLlm.outputPrice != null ? (
            <p>¥{formatPrice(selectedLlm.inputPrice)}/1M {tx("输入", "in")} · ¥{formatPrice(selectedLlm.outputPrice)}/1M {tx("输出", "out")}</p>
          ) : null}
          {!selectedLlm.isAvailable ? <p className="runtime-model-picker__error">{translateUnavailableReason(selectedLlm.unavailableReason, tx)}</p> : null}
        </div>
      ) : value ? (
        <p className="runtime-model-picker__hint">
          {tx(`所选模型“${value}”不在 ${formatDaemonProviderLabel(provider)} 目录中；若不兼容，请求可能被拒绝。`, `Selected model “${value}” is not in the ${formatDaemonProviderLabel(provider)} catalog; it may be rejected if incompatible.`)}
        </p>
      ) : null}

      {error ? <p className="runtime-model-picker__error">{error}</p> : null}
    </div>
  );
}

function formatModelMeta(option: ModelCatalogOption, labels: ModelCatalogSelectLabels): string {
  return [
    option.protocol,
    option.contextLength ? `${formatTokens(option.contextLength)} ${labels.context}` : undefined,
    option.supportsFunctionCalling ? labels.tools : undefined,
    option.supportsVision ? labels.vision : undefined,
    option.inputPrice != null || option.outputPrice != null
      ? `¥${formatPrice(option.inputPrice)}/¥${formatPrice(option.outputPrice)} ${labels.perMillion}`
      : undefined,
  ].filter(Boolean).join(" · ") || labels.available;
}

function translateUnavailableReason(reason: string | undefined, tx: (zh: string, en: string) => string): string {
  if (!reason) return tx("不可用", "Unavailable");
  const protocolMatch = reason.match(/^Runtime protocol \((.+)\) not supported$/);
  if (protocolMatch?.[1]) return tx(`不支持执行引擎协议（${protocolMatch[1]}）`, reason);
  if (reason === "Disabled by team policy") return tx("已被团队策略禁用", reason);
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
