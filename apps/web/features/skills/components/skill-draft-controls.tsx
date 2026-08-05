"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { runToastAction } from "@/shared/lib/toast-action";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import {
  discardSkillDraftAction,
  publishSkillDraftAction,
  readSkillDraftAction,
  saveSkillDraftAction,
} from "@/features/skills/skill-draft-actions";

interface SkillDraftControlsProps {
  skillId: string;
  skillName: string;
  skillDescription: string;
  files: Array<{ path: string; content: string }>;
  onDraftChanged?: () => void;
}

/** 服务器端草稿控制（P1-3）：保存草稿 / 查看 / 发布 / 丢弃。 */
export function SkillDraftControls({
  skillId,
  skillName,
  skillDescription,
  files,
  onDraftChanged,
}: SkillDraftControlsProps) {
  const { tx } = useLanguage();
  const { pushToast } = useFeedbackToast();
  const [hasDraft, setHasDraft] = useState(false);
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string>();
  const [pending, setPending] = useState(false);

  const reload = useCallback(() => {
    void readSkillDraftAction({ skillId }).then((draft) => {
      setHasDraft(draft !== null);
      setDraftUpdatedAt(draft?.updatedAt);
    }).catch(() => setHasDraft(false));
  }, [skillId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const saveDraft = () => {
    setPending(true);
    void runToastAction({
      action: () => saveSkillDraftAction({
        skillId,
        name: skillName,
        description: skillDescription,
        files: files.map((file) => ({ path: file.path, content: file.content })),
      }),
      pushToast,
      tx,
      fallbackError: { zh: "保存草稿失败。", en: "Failed to save draft." },
      onSuccess: () => {
        reload();
        onDraftChanged?.();
      },
    }).finally(() => setPending(false));
  };

  const publishDraft = () => {
    if (!window.confirm(tx("发布草稿将覆盖当前线上 Skill 内容，确定？", "Publishing will overwrite the live skill. Continue?"))) return;
    setPending(true);
    void runToastAction({
      action: () => publishSkillDraftAction({ skillId }),
      pushToast,
      tx,
      fallbackError: { zh: "发布草稿失败。", en: "Failed to publish draft." },
      onSuccess: () => {
        reload();
        onDraftChanged?.();
      },
    }).finally(() => setPending(false));
  };

  const discardDraft = () => {
    setPending(true);
    void runToastAction({
      action: () => discardSkillDraftAction({ skillId }),
      pushToast,
      tx,
      fallbackError: { zh: "丢弃草稿失败。", en: "Failed to discard draft." },
      onSuccess: reload,
    }).finally(() => setPending(false));
  };

  return (
    <div className="skill-draft-controls">
      {hasDraft ? (
        <>
          <span className="skill-draft-controls__badge" title={draftUpdatedAt}>
            <AppIcon name="edit" />{tx("有草稿", "Draft")}
          </span>
          <button className="action-button action-button--compact" disabled={pending} onClick={publishDraft} type="button">
            <AppIcon name="checkCircle" />{tx("发布草稿", "Publish draft")}
          </button>
          <button className="action-button action-button--compact" disabled={pending} onClick={discardDraft} type="button">
            <AppIcon name="close" />{tx("丢弃草稿", "Discard draft")}
          </button>
        </>
      ) : (
        <button className="action-button action-button--compact" disabled={pending} onClick={saveDraft} type="button">
          <AppIcon name="edit" />{tx("保存草稿", "Save draft")}
        </button>
      )}
    </div>
  );
}
