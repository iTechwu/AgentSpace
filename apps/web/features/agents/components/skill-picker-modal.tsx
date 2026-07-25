import Link from "next/link";
import { usePathname } from "next/navigation";
import { buildWorkspacePath, parseWorkspacePathname } from "@/features/auth/workspace-paths";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import type { WorkspaceSkill } from "@dofe-agent/domain/workspace";
import { AppIcon } from "@/shared/ui/app-icon";

interface SkillPickerModalProps {
  readonly pending: boolean;
  readonly skills: WorkspaceSkill[];
  readonly onCancel: () => void;
  readonly onSelect: (skillId: string) => void;
}

export function SkillPickerModal({
  pending,
  skills,
  onCancel,
  onSelect,
}: SkillPickerModalProps) {
  const { tx } = useLanguage();
  const pathname = usePathname();
  const { workspaceSlug } = parseWorkspacePathname(pathname);
  const manageSkillsHref = workspaceSlug ? buildWorkspacePath(workspaceSlug, "/skills") : "/skills";
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLDivElement>(onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <div aria-labelledby={labelId} aria-modal="true" className="modal-card modal-card--compact" ref={surfaceRef} role="dialog" tabIndex={-1}>
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("添加 Skill", "Add skill")}</h3>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          {skills.length > 0 ? (
            <div className="skill-picker-list">
              {skills.map((skill) => (
                <button
                  className="skill-picker-row"
                  disabled={pending}
                  key={skill.id}
                  onClick={() => onSelect(skill.id)}
                  type="button"
                >
                  <div>
                    <strong>{skill.name}</strong>
                    <p>{skill.description || tx("暂无描述", "No description")}</p>
                    <p>{translateSkillSourceLabel(skill, tx)}</p>
                  </div>
                  <span>{tx(`${skill.files.length} 文件`, `${skill.files.length} files`)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="delete-warning modal-card__note">
              <strong>{tx("没有可绑定的 Skills", "No assignable skills")}</strong>
              <p>{tx("技能库为空或已全部绑定。", "The library is empty or already assigned.")}</p>
            </div>
          )}
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <Link className="primary-button" href={manageSkillsHref} onClick={onCancel}>
            {tx("管理 Skills", "Manage skills")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function translateSkillSourceLabel(
  skill: WorkspaceSkill,
  tx: (zh: string, en: string) => string,
): string {
  if (skill.sourceType === "builtin") {
    return tx("系统默认技能", "System default skill");
  }
  if (skill.sourceType === "github") {
    return tx("来自 GitHub 导入", "Imported from GitHub");
  }
  if (skill.sourceType === "skills.sh") {
    return tx("来自 skills.sh 导入", "Imported from skills.sh");
  }
  if (skill.sourceType === "clawhub") {
    return tx("来自 ClawHub 导入", "Imported from ClawHub");
  }
  if (skill.sourceType === "local") {
    return tx("来自本地导入", "Imported from local files");
  }
  return tx("手动创建", "Created manually");
}
