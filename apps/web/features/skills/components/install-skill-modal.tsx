"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  approveSkillInstallAction,
  createSkillInstallationAction,
  inspectSkillInstallationAction,
  listSkillInstallableRuntimesAction,
  type SkillInstallableRuntime,
  type SkillInstallationInspectionView,
} from "@/features/skills/installation-actions";

interface InstallSkillModalProps {
  readonly skillId: string;
  readonly onCancel: () => void;
  readonly onInstalled?: () => void;
}

export function InstallSkillModal({ skillId, onCancel, onInstalled }: InstallSkillModalProps) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const [inspection, setInspection] = useState<SkillInstallationInspectionView>();
  const [runtimes, setRuntimes] = useState<SkillInstallableRuntime[]>([]);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState("");
  const [step, setStep] = useState(0);
  const [loadGeneration, setLoadGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(false);
  const [riskApprovals, setRiskApprovals] = useState<Record<string, boolean>>({});
  const [approvalReason, setApprovalReason] = useState("");

  const load = useCallback(() => setLoadGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    void Promise.all([
      inspectSkillInstallationAction({ skillId }),
      listSkillInstallableRuntimesAction(),
    ]).then(([nextInspection, rows]) => {
      if (cancelled) return;
      setInspection(nextInspection);
      setRuntimes(rows);
      const firstOnline = rows.find((runtime) => runtime.status === "online");
      setSelectedRuntimeId((current) => current || firstOnline?.id || "");
      // A fresh inspection resets the per-item risk authorization state.
      setRiskApprovals({});
      setApprovalReason("");
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : tx("安装检查失败。", "Installation inspection failed."));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [loadGeneration, skillId, tx]);

  const selectedRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.id === selectedRuntimeId),
    [runtimes, selectedRuntimeId],
  );
  const blocked = (inspection?.unresolvedRequired.length ?? 0) > 0;
  const riskItems = inspection?.riskItems ?? [];
  const allRisksApproved = riskItems.length > 0 && riskItems.every((item) => riskApprovals[item.key]);
  const steps = [
    tx("包检查", "Package"),
    tx("Runtime", "Runtime"),
    tx("能力与服务", "Access"),
    tx("就绪约束", "Readiness"),
    tx("确认", "Confirm"),
  ];

  const confirmInstall = async () => {
    if (!selectedRuntimeId || !inspection || blocked) return;
    if (riskItems.length > 0 && !allRisksApproved) return;
    setPending(true);
    try {
      // First-install risk gate (P0-2): record an immutable per-item approval
      // bound to artifact + release lock + risk decision, then create the plan
      // which consumes it atomically.
      let approvalId: string | undefined;
      if (riskItems.length > 0) {
        const approved = await approveSkillInstallAction({
          skillId,
          reason: approvalReason.trim() || tx("管理员逐项审批授权", "Admin per-item risk approval"),
        });
        approvalId = approved.approvalId;
      }
      await runToastAction({
        action: () => createSkillInstallationAction({ skillId, runtimeId: selectedRuntimeId, approvalId }),
        pushToast,
        tx,
        fallbackError: { zh: "创建安装计划失败。", en: "Failed to create the installation plan." },
        onSuccess: () => onInstalled?.(),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card modal-card--skill-install"
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (step === steps.length - 1) confirmInstall();
          else setStep((value) => Math.min(value + 1, steps.length - 1));
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("安装 Skill", "Install skill")}</h3>
            <p id={descriptionId}>
              {inspection
                ? `${inspection.artifact.name} · ${inspection.artifact.version || tx("未标版本", "unversioned")} · ${inspection.artifact.digest.slice(0, 12)}…`
                : tx("读取不可变 artifact…", "Reading immutable artifact…")}
            </p>
          </div>
          <button aria-label={tx("关闭", "Close")} className="modal-close" onClick={onCancel} title={tx("关闭", "Close")} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <ol aria-label={tx("安装步骤", "Installation steps")} className="skill-install-steps">
          {steps.map((label, index) => (
            <li className={index === step ? "skill-install-steps__item skill-install-steps__item--active" : index < step ? "skill-install-steps__item skill-install-steps__item--done" : "skill-install-steps__item"} key={label}>
              <button disabled={index > step || loading} onClick={() => setStep(index)} type="button">
                <span>{index + 1}</span>{label}
              </button>
            </li>
          ))}
        </ol>

        <div className="modal-card__body skill-install-wizard">
          {loading ? <div className="skill-install-state"><AppIcon className="spin" name="loader" /><span>{tx("正在检查 Skill…", "Inspecting skill…")}</span></div> : null}
          {!loading && loadError ? (
            <div className="skill-install-state skill-install-state--error" role="alert">
              <AppIcon name="alertCircle" />
              <strong>{tx("无法完成安装检查", "Inspection failed")}</strong>
              <span>{loadError}</span>
              <button className="modal-secondary-button" onClick={load} type="button"><AppIcon name="refresh" />{tx("重试", "Retry")}</button>
            </div>
          ) : null}

          {!loading && !loadError && inspection && step === 0 ? (
            <section className="skill-install-step-panel">
              <div className="skill-install-summary">
                <div><span>{tx("文件", "Files")}</span><strong>{inspection.artifact.fileCount}</strong></div>
                <div><span>{tx("总大小", "Total size")}</span><strong>{formatBytes(inspection.artifact.totalSizeBytes)}</strong></div>
                <div><span>{tx("来源", "Source")}</span><strong>{inspection.artifact.sourceType}</strong></div>
                <div><span>{tx("可执行文件", "Executables")}</span><strong>{inspection.files.filter((file) => file.mode === "0755").length}</strong></div>
              </div>
              <div className="skill-install-file-list">
                {inspection.files.map((file) => (
                  <div key={file.path}><code>{file.path}</code><span>{file.mode} · {formatBytes(file.sizeBytes)}</span></div>
                ))}
              </div>
            </section>
          ) : null}

          {!loading && !loadError && inspection && step === 1 ? (
            <fieldset className="form-field skill-install-step-panel">
              <legend>{tx("目标 Runtime", "Target runtime")}</legend>
              {runtimes.length === 0 ? <p className="skill-install-alert">{tx("没有在线 Runtime。", "No online runtime is available.")}</p> : (
                <div className="skill-runtime-picker" role="radiogroup" aria-label={tx("目标 Runtime", "Target runtime")}>
                  {runtimes.map((runtime) => {
                    const offline = runtime.status !== "online";
                    return (
                      <label className={`skill-runtime-picker__option${selectedRuntimeId === runtime.id ? " skill-runtime-picker__option--active" : ""}${offline ? " skill-runtime-picker__option--disabled" : ""}`} key={runtime.id}>
                        <input checked={selectedRuntimeId === runtime.id} disabled={offline} name="runtime" onChange={() => setSelectedRuntimeId(runtime.id)} type="radio" value={runtime.id} />
                        <span className="skill-runtime-picker__name">{runtime.name}</span>
                        <span className="skill-runtime-picker__meta">{runtime.provider} · {offline ? tx("离线", "offline") : tx("在线", "online")}{runtime.provisioningState ? ` · ${runtime.provisioningState}` : ""}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ) : null}

          {!loading && !loadError && inspection && step === 2 ? (
            <section className="skill-install-step-panel skill-install-declarations">
              <DeclarationGroup title={tx("依赖", "Dependencies")} empty={tx("无", "None")} rows={inspection.dependencies.map((item) => `${item.kind}:${item.name}@${item.version}${item.integrity ? " · integrity" : ""}`)} />
              <DeclarationGroup title={tx("CLI / MCP 能力", "CLI / MCP access")} empty={tx("无", "None")} rows={inspection.capabilities.map((item) => `${item.kind}:${item.catalogSlug}${item.requiredTools.length ? ` · ${item.requiredTools.join(", ")}` : ""}`)} />
              <DeclarationGroup title={tx("支撑服务", "Support services")} empty={tx("无", "None")} rows={inspection.services.map((item) => `${item.catalogSlug}@${item.templateVersion} · ${item.required ? tx("必需", "required") : tx("可选", "optional")}`)} />
              <DeclarationGroup title={tx("脚本入口", "Script entrypoints")} empty={tx("无", "None")} rows={inspection.entrypoints.map((item) => `${item.runtime}:${item.path}`)} />
              {riskItems.length > 0 ? (
                <fieldset className="skill-install-risk-approvals">
                  <legend>{tx("高风险能力逐项授权", "Per-item high-risk approval")}</legend>
                  <p className="skill-install-risk-hint">
                    {tx("此 Skill 声明了以下高风险能力，请逐项确认已了解其影响后授权。未全部授权无法创建安装计划。", "This skill declares high-risk capabilities. Confirm each item individually to authorize. The plan cannot be created until all are authorized.")}
                  </p>
                  <ul>
                    {riskItems.map((item) => (
                      <li key={item.key}>
                        <label className="skill-install-risk-option">
                          <input
                            checked={riskApprovals[item.key] === true}
                            onChange={(event) => setRiskApprovals((current) => ({ ...current, [item.key]: event.target.checked }))}
                            type="checkbox"
                          />
                          <span className="skill-install-risk-category">{riskCategoryLabel(item.category, tx)}</span>
                          <code>{item.key}</code>
                          <span className="skill-install-risk-description">{item.description}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ) : null}
            </section>
          ) : null}

          {!loading && !loadError && inspection && step === 3 ? (
            <section className="skill-install-step-panel">
              {blocked ? (
                <div className="skill-install-alert skill-install-alert--danger" role="alert"><AppIcon name="alertCircle" /><div><strong>{tx("必需能力未解析", "Required capability unresolved")}</strong>{inspection.unresolvedRequired.map((item) => <code key={item}>{item}</code>)}</div></div>
              ) : (
                <div className="skill-install-alert skill-install-alert--success"><AppIcon name="checkCircle" /><strong>{tx("Release lock 已完整解析", "Release lock resolved")}</strong></div>
              )}
              <div className="skill-install-component-grid">
                {inspection.components.map((component) => <div key={`${component.kind}:${component.key}`}><span>{component.kind}</span><code>{component.key}</code></div>)}
              </div>
              <p className="skill-install-lock"><span>release lock</span><code>{inspection.releaseLockDigest}</code></p>
            </section>
          ) : null}

          {!loading && !loadError && inspection && step === 4 ? (
            <section className="skill-install-step-panel skill-install-confirmation">
              <dl>
                <div><dt>Skill</dt><dd>{inspection.artifact.name} · {inspection.artifact.version || tx("未标版本", "unversioned")}</dd></div>
                <div><dt>Runtime</dt><dd>{selectedRuntime ? `${selectedRuntime.name} · ${selectedRuntime.provider}` : tx("未选择", "Not selected")}</dd></div>
                <div><dt>Artifact</dt><dd><code>{inspection.artifact.digest}</code></dd></div>
                <div><dt>Release lock</dt><dd><code>{inspection.releaseLockDigest}</code></dd></div>
                <div><dt>{tx("验证组件", "Verification components")}</dt><dd>{inspection.components.length}</dd></div>
              </dl>
              {blocked ? <p className="skill-install-alert skill-install-alert--danger">{tx("必需能力未解析，不能创建安装计划。", "Required capabilities are unresolved; the plan cannot be created.")}</p> : null}
              {riskItems.length > 0 ? (
                <div className="skill-install-risk-confirmation">
                  <div>
                    <span>{tx("待授权风险项", "Risk items to authorize")}</span>
                    <strong>{riskItems.filter((item) => riskApprovals[item.key]).length} / {riskItems.length}</strong>
                  </div>
                  <ul>
                    {riskItems.map((item) => (
                      <li className={riskApprovals[item.key] ? "skill-install-risk-confirmed" : ""} key={item.key}>
                        <span className="skill-install-risk-category">{riskCategoryLabel(item.category, tx)}</span>
                        <code>{item.key}</code>
                      </li>
                    ))}
                  </ul>
                  <label className="form-field">
                    <span>{tx("审批理由", "Approval reason")}</span>
                    <input
                      className="text-input"
                      onChange={(event) => setApprovalReason(event.target.value)}
                      placeholder={tx("说明授权该 Skill 高风险能力的理由…", "Explain why these high-risk capabilities are authorized…")}
                      value={approvalReason}
                    />
                  </label>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" disabled={pending} onClick={step === 0 ? onCancel : () => setStep((value) => Math.max(0, value - 1))} type="button">
            {step > 0 ? <AppIcon name="arrowLeft" /> : null}{step === 0 ? tx("取消", "Cancel") : tx("上一步", "Back")}
          </button>
          <button className="primary-button" disabled={pending || loading || Boolean(loadError) || (step >= 1 && !selectedRuntimeId) || (step === steps.length - 1 && (blocked || (riskItems.length > 0 && !allRisksApproved)))} type="submit">
            {step === steps.length - 1 ? (pending ? tx("创建中…", "Creating…") : <><AppIcon name="checkCircle" />{tx("创建安装计划", "Create plan")}</>) : <>{tx("下一步", "Next")}<AppIcon name="arrowRight" /></>}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeclarationGroup({ title, empty, rows }: { title: string; empty: string; rows: string[] }) {
  return <div><h4>{title}</h4>{rows.length ? <ul>{rows.map((row) => <li key={row}><code>{row}</code></li>)}</ul> : <p>{empty}</p>}</div>;
}

function riskCategoryLabel(category: string, tx: (zh: string, en: string) => string): string {
  switch (category) {
    case "script":
      return tx("脚本", "Script");
    case "network":
      return tx("网络", "Network");
    case "mcp_tool":
      return tx("高风险 MCP 工具", "High-risk MCP tool");
    case "write":
      return tx("写能力", "Write");
    default:
      return category;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
