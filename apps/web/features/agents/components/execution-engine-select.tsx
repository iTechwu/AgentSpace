import { formatDaemonProviderLabel } from "@dofe-agent/domain";
import { useEffect, useId, useRef, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import type { AgentsPageData } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";

type ExecutionEngineOption = AgentsPageData["containerOptions"][number];

interface ExecutionEngineSelectProps {
  readonly label: string;
  readonly name: string;
  readonly options: ExecutionEngineOption[];
  readonly placeholder: string;
  readonly emptyDescription?: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}

export function ExecutionEngineSelect({
  label,
  name,
  options,
  placeholder,
  emptyDescription,
  value,
  disabled = false,
  onChange,
}: ExecutionEngineSelectProps) {
  const { tx } = useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.id === value) ?? null;
  const isDisabled = disabled || options.length === 0;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="execution-engine-select" ref={rootRef}>
      <input name={name} readOnly type="hidden" value={selectedOption?.id ?? ""} />
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className={`execution-engine-select__button${open ? " execution-engine-select__button--open" : ""}`}
        disabled={isDisabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        type="button"
      >
        <span className="execution-engine-select__marker">
          <AppIcon name="containers" />
        </span>
        <span className="execution-engine-select__summary">
          {selectedOption ? (
            <>
              <span className="execution-engine-select__title-row">
                <strong>{selectedOption.label}</strong>
                {selectedOption.managed ? <ReusableBadge /> : null}
                <EngineStatusBadge status={selectedOption.status} />
              </span>
              <EngineMeta option={selectedOption} />
            </>
          ) : (
            <>
              <span className="execution-engine-select__placeholder">{placeholder}</span>
              <span className="execution-engine-select__empty-copy">
                {options.length === 0
                  ? emptyDescription ?? tx("当前没有在线执行引擎", "No online execution engines")
                  : tx("可按服务器名称区分执行位置", "Server names distinguish execution targets")}
              </span>
            </>
          )}
        </span>
        <AppIcon className="execution-engine-select__chevron" name="chevronDown" />
      </button>

      {open && !isDisabled ? (
        <div aria-label={label} className="execution-engine-select__menu" id={menuId} role="listbox">
          {options.map((option) => {
            const sharingClosed = option.managed === true && option.allowNewEmployeeSharing === false;
            return (
              <button
                aria-disabled={sharingClosed || undefined}
                aria-selected={option.id === selectedOption?.id}
                className={`execution-engine-select__option${option.id === selectedOption?.id ? " execution-engine-select__option--selected" : ""}${sharingClosed ? " execution-engine-select__option--disabled" : ""}`}
                disabled={sharingClosed}
                key={option.id}
                onClick={() => {
                  if (sharingClosed) {
                    return;
                  }
                  onChange(option.id);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span className="execution-engine-select__option-main">
                  <span>
                    <strong>{option.label}</strong>
                    {option.managed ? <ReusableBadge /> : null}
                    <EngineMeta option={option} />
                    {sharingClosed ? (
                      <span className="execution-engine-select__sharing-closed">
                        {tx("已关闭新员工共享", "New employee sharing disabled")}
                      </span>
                    ) : null}
                  </span>
                  <EngineStatusBadge status={option.status} />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function resolveExecutionEngineValue(
  value: string | undefined,
  options: AgentsPageData["containerOptions"],
): string {
  return value && options.some((option) => option.id === value) ? value : "";
}

function EngineMeta({ option }: { readonly option: ExecutionEngineOption }) {
  const { tx } = useLanguage();
  return (
    <span className="execution-engine-select__meta">
      <span>{option.serverName || option.daemonKey}</span>
      <span>{formatDaemonProviderLabel(option.provider)}</span>
      <span>{option.mode === "remote" ? tx("远程", "Remote") : tx("本地", "Local")}</span>
      {option.defaultModel ? <span>{tx("默认模型", "Default model")}: {option.defaultModel}</span> : null}
      {typeof option.assignedEmployeeCount === "number" ? (
        <span>{tx(`已服务 ${option.assignedEmployeeCount} 个 AI员工`, `${option.assignedEmployeeCount} AI employee(s) served`)}</span>
      ) : null}
      {option.daemonKey.trim() ? <code>{option.daemonKey}</code> : null}
    </span>
  );
}

function EngineStatusBadge({ status }: { readonly status: ExecutionEngineOption["status"] }) {
  const { tx } = useLanguage();
  return (
    <span className={`execution-engine-select__status execution-engine-select__status--${status}`}>
      {status === "online" ? tx("在线", "Online") : tx("离线", "Offline")}
    </span>
  );
}

function ReusableBadge() {
  const { tx } = useLanguage();
  return (
    <span className="execution-engine-select__reusable-badge">{tx("可复用", "Reusable")}</span>
  );
}
