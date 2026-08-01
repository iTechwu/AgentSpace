"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  createSkillInstallationAction,
  listSkillInstallableRuntimesAction,
  type SkillInstallableRuntime,
} from "@/features/skills/installation-actions";

interface InstallSkillModalProps {
  readonly skillId: string;
  readonly onCancel: () => void;
  readonly onInstalled?: () => void;
}

/**
 * Skill 安装向导（Phase 5）：选择目标 Runtime 并创建 installation plan。
 * plan 创建后由 daemon 通过 skill-operations REST 协议准备环境；控制面只建模，
 * 不直接操作 Runtime（02-架构设计.md §4.1）。
 */
export function InstallSkillModal({
  skillId,
  onCancel,
  onInstalled,
}: InstallSkillModalProps) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const [runtimes, setRuntimes] = useState<SkillInstallableRuntime[]>([]);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listSkillInstallableRuntimesAction().then((rows) => {
      if (cancelled) {
        return;
      }
      setRuntimes(rows);
      const firstOnline = rows.find((runtime) => runtime.status === "online");
      setSelectedRuntimeId(firstOnline?.id ?? rows[0]?.id ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmInstall = () => {
    if (!selectedRuntimeId) {
      return;
    }
    setPending(true);
    void runToastAction({
      action: () => createSkillInstallationAction({ skillId, runtimeId: selectedRuntimeId }),
      pushToast,
      tx,
      fallbackError: { zh: "创建安装计划失败。", en: "Failed to create the installation plan." },
      onSuccess: () => {
        onInstalled?.();
      },
    }).finally(() => {
      setPending(false);
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card"
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          confirmInstall();
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("安装到 Runtime", "Install to a runtime")}</h3>
            <p id={descriptionId}>
              {tx("选择目标 Runtime。系统将生成安装计划；daemon 在目标机器上准备只读 artifact、依赖与能力，全部验证通过后才标记为 ready。",
                "Pick a target runtime. A plan is created; the daemon prepares the read-only artifact, dependencies and capabilities on that machine, and the skill only becomes ready once every component verifies.")}
            </p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body">
          <fieldset className="form-field">
            <legend>{tx("目标 Runtime", "Target runtime")}</legend>
            {runtimes.length === 0 ? (
              <p className="form-field__hint">{tx("正在加载 Runtime 列表…", "Loading runtimes…")}</p>
            ) : (
              <div className="skill-runtime-picker" role="radiogroup" aria-label={tx("目标 Runtime", "Target runtime")}>
                {runtimes.map((runtime) => {
                  const offline = runtime.status !== "online";
                  return (
                    <label
                      className={`skill-runtime-picker__option${selectedRuntimeId === runtime.id ? " skill-runtime-picker__option--active" : ""}${offline ? " skill-runtime-picker__option--disabled" : ""}`}
                      key={runtime.id}
                    >
                      <input
                        checked={selectedRuntimeId === runtime.id}
                        disabled={offline}
                        name="runtime"
                        onChange={() => setSelectedRuntimeId(runtime.id)}
                        type="radio"
                        value={runtime.id}
                      />
                      <span className="skill-runtime-picker__name">
                        {runtime.name}
                        {offline ? ` · ${tx("离线", "offline")}` : ""}
                      </span>
                      <span className="skill-runtime-picker__meta">
                        {runtime.provider}
                        {runtime.provisioningState ? ` · ${runtime.provisioningState}` : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="form-field__hint" role="note">
            {tx("安装后 Skill 需所有必需组件（依赖 / 脚本 / CLI / MCP / 服务）在目标 Runtime 上验证通过才进入任务。",
              "After installation the skill only enters tasks when every required component (dependencies / scripts / CLI / MCP / services) is verified on the target runtime.")}
          </div>
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending || !selectedRuntimeId} type="submit">
            {pending ? tx("创建计划中…", "Creating plan…") : tx("创建安装计划", "Create installation plan")}
          </button>
        </div>
      </form>
    </div>
  );
}
