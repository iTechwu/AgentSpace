"use client";

import { useRef, useState, useTransition } from "react";
import {
  createManagedRuntimeAction,
  preflightManagedRuntimeAction,
} from "@/features/runtimes/actions";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { useLanguage } from "@/features/i18n/language-provider";
import {
  DAEMON_PROVIDER_IDS,
  formatDaemonProviderLabel,
  resolveProviderDefaultModel,
  type DaemonProvider,
} from "@dofe-agent/domain";
import type { ManagedRuntimeCreationPreflightResult } from "@dofe-agent/services";

export function ManagedRuntimeCreationWizard({
  onResolved,
  targetServers = [],
}: {
  onResolved: (result:
    | { kind: "reused"; runtimeId: string; runtimeName: string }
    | { kind: "provisioning"; taskId: string }
  ) => void;
  targetServers?: Array<{ deviceName: string; status: "online" | "offline" }>;
}) {
  const { tx } = useLanguage();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<DaemonProvider>(DAEMON_PROVIDER_IDS[0] ?? "claude");
  const [name, setName] = useState("");
  const [targetServer, setTargetServer] = useState("");
  const [defaultModel, setDefaultModel] = useState(
    resolveProviderDefaultModel(DAEMON_PROVIDER_IDS[0] ?? "claude") ?? "",
  );
  const [allowNewEmployeeSharing, setAllowNewEmployeeSharing] = useState(true);
  const [forceProvisioning, setForceProvisioning] = useState(false);
  const [preflight, setPreflight] = useState<ManagedRuntimeCreationPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);

  function invalidatePreflight() {
    setPreflight(null);
    setError(null);
    idempotencyKey.current = null;
  }

  function continueToConfirmation() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await preflightManagedRuntimeAction({
          provider,
          defaultModel: defaultModel || undefined,
          forceProvisioning,
        });
        setPreflight(result);
        setStep(3);
      } catch (preflightError) {
        setError(humanizeRuntimeError(preflightError, tx));
      }
    });
  }

  function createRuntime() {
    if (!preflight?.allowed) return;
    setError(null);
    idempotencyKey.current ??= `ui:${provider}:${crypto.randomUUID()}`;
    startTransition(async () => {
      try {
        const result = await createManagedRuntimeAction({
          provider,
          name: name.trim() || undefined,
          defaultModel: defaultModel || undefined,
          targetServer: targetServer.trim() || undefined,
          allowNewEmployeeSharing,
          forceProvisioning,
          idempotencyKey: idempotencyKey.current!,
        });
        onResolved(result);
      } catch (createError) {
        setError(humanizeRuntimeError(createError, tx));
      }
    });
  }

  return (
    <section className="runtimes-panel runtime-wizard" aria-labelledby="runtime-wizard-title">
      <div className="runtimes-panel__header runtime-wizard__header">
        <div>
          <span>{tx("新建", "Create")}</span>
          <h2 id="runtime-wizard-title">{tx("配置执行能力", "Configure execution capacity")}</h2>
        </div>
        <ol className="runtime-wizard__steps" aria-label={tx("创建进度", "Creation progress")}>
          {[
            tx("供应商", "Provider"),
            tx("模型", "Model"),
            tx("确认", "Confirm"),
          ].map((label, index) => {
            const number = (index + 1) as 1 | 2 | 3;
            return (
              <li key={label} className={number === step ? "runtime-wizard__step--active" : ""}>
                <span aria-current={number === step ? "step" : undefined}>{number}. {label}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="runtime-wizard__body">
        {step === 1 ? (
        <div className="runtime-wizard__execution">
          <div className="runtime-wizard__fields runtime-wizard__fields--primary">
          <label className="runtime-field">
            <span>{tx("执行能力类型", "Capacity type")}</span>
            <select
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as DaemonProvider;
                setProvider(nextProvider);
                setDefaultModel(resolveProviderDefaultModel(nextProvider) ?? "");
                invalidatePreflight();
              }}
            >
              {DAEMON_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>{formatDaemonProviderLabel(id)}</option>
              ))}
            </select>
          </label>
          </div>
          <details className="runtime-wizard__advanced">
            <summary>{tx("高级设置", "Advanced settings")}</summary>
            <div className="runtime-wizard__fields">
              <label className="runtime-field">
                <span>{tx("执行能力名称", "Runtime name")}</span>
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    invalidatePreflight();
                  }}
                  placeholder={tx(`托管 ${formatDaemonProviderLabel(provider)}`, `Managed ${formatDaemonProviderLabel(provider)}`)}
                />
              </label>
              <label className="runtime-field">
                <span>{tx("目标执行节点", "Target execution node")}</span>
                <select
                  value={targetServer}
                  onChange={(event) => {
                    setTargetServer(event.target.value);
                    invalidatePreflight();
                  }}
                >
                  <option value="">{tx("自动调度", "Automatic placement")}</option>
                  {targetServers.map((server) => (
                    <option key={server.deviceName} value={server.deviceName} disabled={server.status !== "online"}>
                      {server.deviceName}{server.status === "online" ? "" : tx("（离线）", " (offline)")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="runtime-wizard__sharing runtime-wizard__advanced-toggle">
                <input
                  type="checkbox"
                  checked={forceProvisioning}
                  onChange={(event) => {
                    setForceProvisioning(event.target.checked);
                    invalidatePreflight();
                  }}
                />
                <span>{tx("始终部署独立运行环境", "Always deploy an isolated environment")}</span>
              </label>
              <label className="runtime-wizard__sharing runtime-wizard__advanced-toggle">
                <input
                  type="checkbox"
                  checked={allowNewEmployeeSharing}
                  onChange={(event) => setAllowNewEmployeeSharing(event.target.checked)}
                />
                <span>{tx("允许新的 AI 员工共享新部署的运行环境", "Allow new AI employees to share a newly deployed environment")}</span>
              </label>
            </div>
          </details>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="runtime-wizard__model">
          <RuntimeModelPicker
            provider={provider}
            value={defaultModel}
            onChange={(value) => {
              setDefaultModel(value);
              invalidatePreflight();
            }}
          />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="runtime-wizard__confirmation">
          <dl>
            <dt>{tx("执行能力", "Capacity")}</dt>
            <dd>{formatDaemonProviderLabel(provider)}</dd>
            <dt>{tx("分配方式", "Allocation")}</dt>
            <dd>{preflight?.reusableRuntime
              ? preflight.reusableRuntime.name
              : forceProvisioning
                ? tx("部署独立运行环境", "Deploy isolated environment")
                : tx("自动部署运行环境", "Deploy automatically")}</dd>
            <dt>{tx("执行节点", "Execution node")}</dt>
            <dd>{targetServer.trim() || tx("自动调度", "Automatic placement")}</dd>
            <dt>{tx("默认模型", "Default model")}</dt>
            <dd>{defaultModel || tx("跟随系统默认", "System fallback")}</dd>
          </dl>
          <div className={`runtime-preflight runtime-preflight--${preflight?.allowed ? "passed" : "blocked"}`}>
            <p>{preflight?.allowed
              ? preflight.reusableRuntime
                ? tx("已有可共享执行能力", "Shared capacity available")
                : tx("可以自动部署", "Ready to deploy")
              : tx("预检未通过", "Preflight blocked")}</p>
            <small>
              {formatPreflightSummary(preflight, tx)}
            </small>
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="runtime-wizard__error">{error}</p> : null}

      <div className="runtime-wizard__actions">
        {step > 1 ? (
          <button
            type="button"
            className="action-button"
            disabled={pending}
            onClick={() => setStep(step === 3 ? 2 : 1)}
          >
            {tx("上一步", "Back")}
          </button>
        ) : null}
        {step === 1 ? (
          <button type="button" className="primary-button" onClick={() => setStep(2)}>
            {tx("下一步", "Continue")}
          </button>
        ) : null}
        {step === 2 ? (
          <button type="button" className="primary-button" disabled={pending} onClick={continueToConfirmation}>
            {pending ? tx("检查中...", "Checking...") : tx("检查并确认", "Review")}
          </button>
        ) : null}
        {step === 3 ? (
          <button type="button" className="primary-button" disabled={pending || !preflight?.allowed} onClick={createRuntime}>
            {pending ? tx("配置中...", "Configuring...") : tx("配置执行能力", "Configure capacity")}
          </button>
        ) : null}
      </div>
      </div>
    </section>
  );
}

function formatPreflightSummary(result: ManagedRuntimeCreationPreflightResult | null, tx: (zh: string, en: string) => string): string {
  if (!result) return tx("预检尚未完成。", "Preflight has not completed.");
  if (result.code === "managed_runtime.no_online_node") {
    return tx(
      "当前工作区没有在线托管节点，请先恢复节点连接后再创建执行引擎。",
      "No managed node is online for this workspace. Restore the node connection before creating a runtime.",
    );
  }
  if (!result.allowed) return result.message || tx("需要检查模型可用性或团队余额。", "Model availability or team balance requires attention.");
  if (result.reusableRuntime) {
    return tx("将直接复用兼容的在线执行能力。", "Compatible online capacity will be reused.");
  }
  if (result.availableBalance !== undefined) {
    return tx(`可用余额：${result.availableBalance} ${result.currency ?? ""}`, `Available balance: ${result.availableBalance} ${result.currency ?? ""}`).trim();
  }
  return tx("模型可用性与团队计费已就绪。", "Model availability and team billing are ready.");
}

function humanizeRuntimeError(error: unknown, tx: (zh: string, en: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    "managed_runtime.balance_preflight_rejected": tx("团队余额不足，无法创建此执行引擎。", "The team balance is insufficient for this runtime."),
    "managed_runtime.model_unavailable": tx("所选模型不适用于此执行引擎。", "The selected model is unavailable for this runtime."),
    "managed_runtime.no_compatible_models": tx("没有可用模型支持此执行引擎。", "No available model supports this runtime."),
    "managed_runtime.models_not_configured": tx("模型服务尚未配置。", "The models service is not configured."),
    "managed_runtime.no_online_node": tx(
      "当前工作区没有在线托管节点，请先恢复节点连接后再创建执行引擎。",
      "No managed node is online for this workspace. Restore the node connection before creating a runtime.",
    ),
  };
  return known[message] ?? tx("执行引擎请求未能完成，请检查配置后重试。", "The runtime request could not be completed. Review the configuration and try again.");
}
