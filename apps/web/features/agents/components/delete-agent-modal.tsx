import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";

interface DeleteAgentModalProps {
  readonly agentName: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteAgentModal({
  agentName,
  pending,
  onCancel,
  onConfirm,
}: DeleteAgentModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLDivElement>(onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <div aria-labelledby={labelId} aria-modal="true" className="modal-card modal-card--compact" ref={surfaceRef} role="dialog" tabIndex={-1}>
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>Delete Agent</h3>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <div className="delete-warning modal-card__note">
            <strong>{agentName}</strong>
            <p>{tx("同时移除执行引擎绑定、任务队列和工作区域记录。", "Also removes execution-engine bindings, queued tasks, and work area records.")}</p>
          </div>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="action-button action-button--danger" disabled={pending} onClick={onConfirm} type="button">
            {pending ? tx("删除中...", "Deleting...") : tx("删除", "Delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
