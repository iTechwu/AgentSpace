"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { DAEMON_PROVIDER_IDS, formatDaemonProviderLabel } from "@dofe-agent/domain";
import type { ManagedRuntimeListItem } from "@dofe-agent/services";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import { useLanguage } from "@/features/i18n/language-provider";

export function ManagedRuntimeList({
  runtimes,
  workspaceSlug,
  pending,
  onRotate,
}: {
  runtimes: ManagedRuntimeListItem[];
  workspaceSlug?: string;
  pending: boolean;
  onRotate: (runtimeId: string) => void;
}) {
  const { tx, language } = useLanguage();
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("");
  const [costAttribution, setCostAttribution] = useState("");
  const models = useMemo(
    () => [...new Set(runtimes.map((runtime) => runtime.defaultModel).filter(Boolean))].sort() as string[],
    [runtimes],
  );
  const filtered = runtimes.filter((runtime) =>
    (!provider || runtime.provider === provider)
    && (!status || runtimeStatusFilter(runtime) === status)
    && (!model || runtime.defaultModel === model)
    && (!costAttribution || (costAttribution === "unallocated") === (runtime.unallocatedCostUsd > 0)),
  );

  if (runtimes.length === 0) {
    return (
      <div className="runtimes-empty">
        <strong>{tx("暂无已部署执行引擎", "No provisioned runtimes")}</strong>
        <p>{tx("使用上方流程创建第一个托管执行引擎。", "Use the workflow above to create the first managed runtime.")}</p>
      </div>
    );
  }

  return (
    <div className="runtime-list">
      <div className="runtime-list__filters" aria-label={tx("执行引擎筛选", "Runtime filters")}>
        <FilterSelect allLabel={tx("全部", "All")} label={tx("供应商", "Provider")} value={provider} onChange={setProvider}>
          {DAEMON_PROVIDER_IDS.map((id) => <option key={id} value={id}>{formatDaemonProviderLabel(id)}</option>)}
        </FilterSelect>
        <FilterSelect allLabel={tx("全部", "All")} label={tx("状态", "Status")} value={status} onChange={setStatus}>
          <option value="available">{tx("可用", "Available")}</option>
          <option value="offline">{tx("离线", "Offline")}</option>
          <option value="recovering">{tx("凭证恢复中", "Credential recovery")}</option>
          <option value="attention">{tx("需要处理", "Needs attention")}</option>
          <option value="stopped">{tx("已停止", "Stopped")}</option>
        </FilterSelect>
        <FilterSelect allLabel={tx("全部", "All")} label={tx("模型", "Model")} value={model} onChange={setModel}>
          {models.map((item) => <option key={item} value={item}>{item}</option>)}
        </FilterSelect>
        <FilterSelect allLabel={tx("全部", "All")} label={tx("成本归属", "Cost attribution")} value={costAttribution} onChange={setCostAttribution}>
          <option value="allocated">{tx("已归属", "Allocated")}</option>
          <option value="unallocated">{tx("存在未归属成本", "Has unallocated cost")}</option>
        </FilterSelect>
      </div>
      <div className="runtime-list__table-wrap">
        <table className="runtime-list__table" aria-label={tx("托管执行引擎", "Managed runtimes")}>
          <thead>
            <tr>
              <th>{tx("名称", "Name")}</th><th>{tx("供应商 / 协议", "Provider / protocol")}</th>
              <th>{tx("状态", "Status")}</th><th>{tx("默认模型", "Default model")}</th>
              <th>{tx("AI 员工", "AI employees")}</th><th>{tx("最后心跳", "Last heartbeat")}</th>
              <th>{tx("周期实际成本", "Period actual cost")}</th><th><span className="sr-only">{tx("操作", "Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
      {filtered.map((runtime) => {
        const presentation = presentRuntimeState(runtime, tx);
        return (
          <tr key={runtime.id}>
            <td className="runtime-list__name">{workspaceSlug ? (
              <Link
                className="runtime-list__link"
                href={buildWorkspacePath(workspaceSlug, `/runtimes/runtime/${runtime.id}`)}
              >
                {runtime.name}
              </Link>
            ) : runtime.name}</td>
            <td><span>{formatDaemonProviderLabel(runtime.provider)}</span><small>{runtime.protocols.join(", ") || "—"}</small></td>
            <td><span className={`runtime-status runtime-status--${presentation.tone}`}>{presentation.label}</span><small>{presentation.detail}</small></td>
            <td>{runtime.defaultModel || tx("跟随系统默认", "System fallback")}</td>
            <td className="runtime-list__number">
              {runtime.assignedEmployeeCount}
              {runtime.allowNewEmployeeSharing === false ? (
                <small className="runtime-list__warning">{tx("已关闭新 AI 员工共享", "Sharing closed to new AI employees")}</small>
              ) : null}
            </td>
            <td>{formatHeartbeat(runtime.lastHeartbeatAt, language)}</td>
            <td className="runtime-list__number"><span>{formatMoney(runtime.periodActualCostUsd, runtime.periodCurrency)}</span>{runtime.unallocatedCostUsd > 0 ? <small className="runtime-list__warning">{formatMoney(runtime.unallocatedCostUsd, runtime.periodCurrency)} {tx("未归属", "unallocated")}</small> : null}</td>
            <td className="runtime-list__actions">{runtime.provisioningState === "needs_attention" ? (
              <button
                type="button"
                className="action-button runtime-action-button"
                disabled={pending}
                onClick={() => onRotate(runtime.id)}
              >
                {tx("轮换凭证", "Rotate key")}
              </button>
            ) : null}</td>
          </tr>
        );
      })}
          </tbody>
        </table>
        {filtered.length === 0 ? <p className="runtime-list__no-results">{tx("没有符合筛选条件的执行引擎。", "No runtimes match these filters.")}</p> : null}
      </div>
    </div>
  );
}

function FilterSelect({ label, allLabel, value, onChange, children }: { label: string; allLabel: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="runtime-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{allLabel}</option>{children}</select></label>;
}

function runtimeStatusFilter(runtime: ManagedRuntimeListItem): string {
  if (runtime.provisioningState === "credential_recovering") return "recovering";
  if (runtime.provisioningState === "needs_attention") return "attention";
  if (runtime.provisioningState === "legacy") return "stopped";
  return runtime.status === "online" ? "available" : "offline";
}

function formatHeartbeat(value: string | undefined, language: "zh" | "en"): string {
  if (!value) return language === "zh" ? "从未" : "Never";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCny(value: number): string {
  return `¥${value.toFixed(4)}`;
}

function formatMoney(value: number, currency?: string): string {
  const normalized = currency?.trim().toUpperCase();
  return !normalized || normalized === "CNY" ? formatCny(value) : `${value.toFixed(4)} ${normalized}`;
}

function presentRuntimeState(runtime: ManagedRuntimeListItem, tx: (zh: string, en: string) => string): {
  label: string;
  detail: string;
  tone: string;
} {
  if (runtime.provisioningState === "credential_recovering") {
    return {
      label: tx("凭证恢复中", "Credential recovery"),
      detail: tx("正在更新网关凭证，新任务已暂停。", "Updating the gateway credential; new tasks are paused."),
      tone: "recovering",
    };
  }
  if (runtime.provisioningState === "needs_attention") {
    return {
      label: tx("需要处理", "Needs attention"),
      detail: tx("自动恢复在三次尝试后已停止。", "Automatic recovery stopped after three attempts."),
      tone: "attention",
    };
  }
  if (runtime.provisioningState === "legacy") {
    return {
      label: tx("已停止", "Stopped"),
      detail: tx("此执行引擎不再接收新任务。", "This runtime is not accepting new tasks."),
      tone: "stopped",
    };
  }
  return runtime.status === "online"
    ? {
        label: tx("可用", "Available"),
        detail: tx("凭证已验证，可以接受调度。", "Credential verified and ready for scheduling."),
        tone: "available",
      }
    : {
        label: tx("离线", "Offline"),
        detail: tx("正在等待托管节点心跳。", "Waiting for the managed node heartbeat."),
        tone: "offline",
      };
}
