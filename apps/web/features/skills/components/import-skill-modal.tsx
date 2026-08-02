import { useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { getField } from "@/shared/lib/form";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";

type SkillImportSource = "github" | "gitlab" | "skills.sh" | "clawhub" | "upload";

interface ImportSkillModalProps {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input:
    | {
      url: string;
      conflict: "reject" | "rename" | "replace" | "skip";
    }
    | {
      archive: File;
      conflict: "reject" | "rename" | "replace" | "skip";
    }) => void;
}

export function ImportSkillModal({
  pending,
  onCancel,
  onConfirm,
}: ImportSkillModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const [source, setSource] = useState<SkillImportSource>("github");
  const [archive, setArchive] = useState<File | null>(null);
  const sourceOptions = useMemo(
    () => [
      {
        value: "github" as const,
        label: "GitHub",
        hint: tx("粘贴 GitHub tree/blob/raw skill 链接。", "Paste a GitHub tree/blob/raw skill URL."),
        placeholder: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
      },
      {
        value: "gitlab" as const,
        label: "GitLab",
        hint: tx("粘贴 gitlab.com 的 tree/blob/raw Skill 链接。", "Paste a gitlab.com tree/blob/raw skill URL."),
        placeholder: "https://gitlab.com/octo-group/skill-repo/-/tree/main/skills/research-pack",
      },
      {
        value: "skills.sh" as const,
        label: "skills.sh",
        hint: tx("粘贴 skills.sh 页面链接，或输入 owner/repo/skill。", "Paste a skills.sh page URL or enter owner/repo/skill."),
        placeholder: "https://skills.sh/apollographql/skills/skill-creator",
      },
      {
        value: "clawhub" as const,
        label: "ClawHub",
        hint: tx("粘贴 ClawHub skill 页面链接，或输入 owner/skill-slug。", "Paste a ClawHub skill page URL or enter owner/skill-slug."),
        placeholder: "https://clawhub.ai/fangkelvin/find-skills-skill",
      },
      {
        value: "upload" as const,
        label: tx("上传 ZIP", "Upload ZIP"),
        hint: tx("选择本机 Skill zip，文件会先上传到 TOS，再由服务端解析导入。", "Choose a local Skill zip. It is uploaded to TOS before the server imports it."),
      },
    ],
    [tx],
  );
  const activeSource = sourceOptions.find((option) => option.value === source) ?? sourceOptions[0]!;

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card modal-card--compact"
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const conflict = getField(formData, "conflict") as "reject" | "rename" | "replace" | "skip";
          if (source === "upload") {
            if (archive && archive.size > 0) {
              onConfirm({ archive, conflict });
            }
            return;
          }
          onConfirm({ url: normalizeImportSourceInput(getField(formData, "url"), source), conflict });
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("导入 Skill", "Import skill")}</h3>
            <p id={descriptionId}>{tx("支持 GitHub / GitLab / skills.sh / ClawHub，以及上传本机 zip 后导入。", "Supports GitHub / GitLab / skills.sh / ClawHub and locally uploaded zip files.")}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <div className="skill-import-source-picker" role="group" aria-label={tx("导入来源", "Import source")}>
            {sourceOptions.map((option) => (
              <button
                aria-label={tx(`选择 ${option.label} 导入来源`, `Select ${option.label} import source`)}
                className={`skill-import-source-picker__button${source === option.value ? " skill-import-source-picker__button--active" : ""}`}
                key={option.value}
                onClick={() => {
                  setSource(option.value);
                  if (option.value !== "upload") {
                    setArchive(null);
                  }
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>

          {source === "upload" ? (
            <label className="form-field">
              <span>{tx("Skill 压缩包", "Skill archive")}</span>
              <input
                accept=".zip,application/zip,application/x-zip-compressed"
                aria-label={tx("Skill 压缩包", "Skill archive")}
                autoFocus
                name="archive"
                onChange={(event) => setArchive(event.currentTarget.files?.[0] ?? null)}
                type="file"
              />
              <small className="form-field__hint">{activeSource.hint}</small>
            </label>
          ) : (
            <label className="form-field">
              <span>{tx("来源 URL", "Source URL")}</span>
              <input
                aria-label={tx("来源 URL", "Source URL")}
                autoFocus
                name="url"
                placeholder={activeSource.placeholder}
                type="text"
              />
              <small className="form-field__hint">{activeSource.hint}</small>
            </label>
          )}

          <label className="form-field">
            <span>{tx("冲突策略", "Conflict strategy")}</span>
            <select defaultValue="rename" name="conflict">
              <option value="reject">{tx("拒绝导入", "Reject import")}</option>
              <option value="rename">{tx("自动重命名", "Rename imported skill")}</option>
              <option value="replace">{tx("替换现有 Skill", "Replace existing skill")}</option>
              <option value="skip">{tx("已存在则跳过", "Skip existing skill")}</option>
            </select>
          </label>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending || (source === "upload" && !archive)} type="submit">
            {pending ? tx("导入中...", "Importing...") : tx("开始导入", "Import")}
          </button>
        </div>
      </form>
    </div>
  );
}

function normalizeImportSourceInput(value: string, source: SkillImportSource): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith(".")) {
    return trimmed;
  }

  if (source === "skills.sh") {
    return `https://skills.sh/${trimmed.replace(/^\/+/, "")}`;
  }

  if (source === "clawhub") {
    return `https://clawhub.ai/${trimmed.replace(/^\/+/, "")}`;
  }

  return trimmed;
}
