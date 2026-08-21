"use client";

// channels-page 弹窗：加成员 / 数字联系人备注 / 频道重命名（3.4-3 拆分自 channels-page-client.tsx）。

import { useMemo, useState } from "react";
import type { ChannelsPageData } from "@/features/dashboard/data";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

export type AddChannelMemberCandidate = NonNullable<ChannelsPageData["channelMemberCandidates"]>[number];

export function channelMemberCandidateKey(candidate: AddChannelMemberCandidate): string {
  return `${candidate.kind}:${candidate.id}`;
}

export function AddChannelMembersModal({
  candidates,
  channelName,
  feedback,
  pending,
  onCancel,
  onConfirm,
}: {
  candidates: AddChannelMemberCandidate[];
  channelName: string;
  feedback: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (input: { userIds: string[]; agentIds: string[] }) => void;
}) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const filteredCandidates = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) {
      return candidates;
    }
    return candidates.filter((candidate) =>
      `${candidate.label} ${candidate.meta} ${candidate.email ?? ""}`
        .toLocaleLowerCase("zh-CN")
        .includes(keyword),
    );
  }, [candidates, query]);

  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedKeys.includes(channelMemberCandidateKey(candidate))),
    [candidates, selectedKeys],
  );

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        className="modal-card modal-card--channel"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm({
            userIds: selectedCandidates.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.id),
            agentIds: selectedCandidates.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.id),
          });
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("添加群成员", "Add members")}</h3>
            <p id={descriptionId}>
              {tx(
                `直接把工作区成员或数字联系人加入「${channelName}」。`,
                `Add workspace members or digital contacts directly to "${channelName}".`,
              )}
            </p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body modal-card__body--channel">
          <label className="form-field form-field--full">
            <span>{tx("群成员", "Members")}</span>
            <input
              autoFocus
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={tx("搜索成员、邮箱或 AI员工", "Search members, email, or AI employees")}
              type="search"
              value={query}
            />
          </label>

          {feedback ? <p aria-live="polite" className="settings-feedback" role="status">{feedback}</p> : null}

          <div className="channel-picker">
            <div className="channel-picker__column">
              <div className="channel-picker__list">
                {filteredCandidates.length > 0 ? (
                  filteredCandidates.map((candidate) => {
                    const key = channelMemberCandidateKey(candidate);
                    const selected = selectedKeys.includes(key);
                    return (
                      <button
                        className={`channel-member-row${selected ? " channel-member-row--selected" : ""}`}
                        key={key}
                        onClick={() =>
                          setSelectedKeys((current) =>
                            current.includes(key)
                              ? current.filter((id) => id !== key)
                              : [...current, key],
                          )
                        }
                        type="button"
                      >
                        <GeneratedAvatar
                          className={`channel-member-row__avatar channel-member-row__avatar--${candidate.kind}`}
                          id={candidate.id}
                          name={candidate.label}
                          variant={candidate.kind}
                        />
                        <div className="channel-member-row__content">
                          <strong>{candidate.label}</strong>
                          <span>{candidate.meta}</span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <EmptyState title={tx("暂无可添加成员", "No available members")} />
                )}
              </div>
            </div>

            <div className="channel-picker__column">
              <div className="panel-header">
                <div>
                  <h3>{tx(`${selectedCandidates.length} 人`, `${selectedCandidates.length} selected`)}</h3>
                </div>
              </div>
              <div className="channel-picker__list">
                {selectedCandidates.length > 0 ? (
                  selectedCandidates.map((candidate) => (
                    <div className="channel-member-row channel-member-row--static" key={channelMemberCandidateKey(candidate)}>
                      <GeneratedAvatar
                        className={`channel-member-row__avatar channel-member-row__avatar--${candidate.kind}`}
                        id={candidate.id}
                        name={candidate.label}
                        variant={candidate.kind}
                      />
                      <div className="channel-member-row__content">
                        <strong>{candidate.label}</strong>
                        <span>{candidate.meta}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState title={tx("未选择成员", "No members selected")} />
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending || selectedCandidates.length === 0} type="submit">
            {pending ? tx("添加中...", "Adding...") : tx("添加", "Add")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DigitalContactRemarkModal({
  contactId,
  currentRemark,
  pending,
  tx,
  onCancel,
  onSave,
}: {
  contactId: string;
  currentRemark: string;
  pending: boolean;
  tx: (zh: string, en: string) => string;
  onCancel: () => void;
  onSave: (remarkName: string) => void;
}) {
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        className="modal-card modal-card--compact"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          onSave((formData.get("remarkName") as string | null)?.trim() || contactId);
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("编辑联系人备注", "Edit contact remark")}</h3>
            <p id={descriptionId}>{tx("备注会显示在数字联系人列表和聊天标题中。", "The remark appears in the digital contacts list and chat title.")}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <label className="form-field">
            <span>{tx("联系人备注", "Contact remark")}</span>
            <input
              aria-label={tx("联系人备注", "Contact remark")}
              autoFocus
              defaultValue={currentRemark}
              name="remarkName"
              placeholder={contactId}
              type="text"
            />
            <small className="form-field__hint">{tx(`原始名称：${contactId}`, `Original name: ${contactId}`)}</small>
          </label>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? tx("保存中...", "Saving...") : tx("保存备注", "Save remark")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function RenameChannelModal({
  channelName,
  languageLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  channelName: string;
  languageLabel: (zh: string, en: string) => string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (nextName: string) => void;
}) {
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
          const nextName = ((formData.get("nextName") as string | null) ?? "").trim();
          onConfirm(nextName);
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{languageLabel("修改群组名称", "Rename channel")}</h3>
            <p id={descriptionId}>{languageLabel(`当前群组：${channelName}`, `Current channel: ${channelName}`)}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <label className="form-field">
            <span>{languageLabel("新名称", "New name")}</span>
            <input autoFocus defaultValue={channelName} name="nextName" type="text" />
          </label>
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {languageLabel("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? languageLabel("保存中...", "Saving...") : languageLabel("保存", "Save")}
          </button>
        </div>
      </form>
    </div>
  );
}
