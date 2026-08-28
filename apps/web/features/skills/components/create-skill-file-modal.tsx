import { useLanguage } from "@/features/i18n/language-provider";
import { getField, getRawField } from "@/shared/lib/form";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";

interface CreateSkillFileModalProps {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input: { path: string; content: string }) => void;
}

export function CreateSkillFileModal({
  pending,
  onCancel,
  onConfirm,
}: CreateSkillFileModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
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
          onConfirm({
            path: getField(formData, "path"),
            content: getRawField(formData, "content"),
          });
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("创建 Skill 文件", "Create skill file")}</h3>
            <p id={descriptionId}>{tx("保留 `SKILL.md`。", "`SKILL.md` is required.")}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <label className="form-field">
            <span>{tx("文件路径", "File path")}</span>
            <input autoFocus name="path" placeholder="references/checklist.md" type="text" />
          </label>
          <label className="form-field">
            <span>{tx("初始内容", "Initial content")}</span>
            <textarea name="content" placeholder={tx("内容", "Content")} rows={6} />
          </label>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? tx("创建中...", "Creating...") : tx("创建", "Create")}
          </button>
        </div>
      </form>
    </div>
  );
}
