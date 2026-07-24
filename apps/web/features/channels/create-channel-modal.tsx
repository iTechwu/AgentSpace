"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { GeneratedAvatar } from "@/shared/ui/generated-avatar";

export interface ChannelMemberCandidate {
  id: string;
  label: string;
  kind: "human" | "agent";
  meta: string;
}

const CHANNEL_MEMBER_PAGE_SIZE = 8;

export function CreateChannelModal({
  pending,
  candidates,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  candidates: ChannelMemberCandidate[];
  onClose: () => void;
  onSubmit: (input: { name: string; humanMemberIds: string[]; agentIds: string[] }) => void;
}) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLFormElement>(onClose);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filteredCandidates = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) {
      return candidates;
    }
    return candidates.filter((candidate) =>
      `${candidate.label} ${candidate.meta}`.toLocaleLowerCase("zh-CN").includes(keyword),
    );
  }, [candidates, query]);
  const pageCount = Math.max(1, Math.ceil(filteredCandidates.length / CHANNEL_MEMBER_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * CHANNEL_MEMBER_PAGE_SIZE;
  const visibleCandidates = filteredCandidates.slice(pageStart, pageStart + CHANNEL_MEMBER_PAGE_SIZE);
  const pageFirst = filteredCandidates.length > 0 ? pageStart + 1 : 0;
  const pageLast = Math.min(pageStart + visibleCandidates.length, filteredCandidates.length);

  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selectedIds.includes(candidate.id)),
    [candidates, selectedIds],
  );

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card modal-card--channel"
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const name = (formData.get("name") as string | null)?.trim() ?? "";
          const humanMemberIds = selectedCandidates.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.id);
          const agentIds = selectedCandidates.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.id);
          onSubmit({ name, humanMemberIds, agentIds });
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("创建群组", "Create channel")}</h3>
          </div>
          <button
            aria-label={tx("关闭创建群组", "Close create channel")}
            className="modal-close"
            onClick={onClose}
            title={tx("关闭", "Close")}
            type="button"
          >
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body modal-card__body--channel">
          <label className="form-field form-field--full">
            <span>{tx("群组名称", "Group name")}</span>
            <input name="name" placeholder={tx("输入群组名称", "Enter a group name")} type="text" />
          </label>

          <div className="channel-picker">
            <div className="channel-picker__column">
              <label className="form-field form-field--full">
                <span>{tx("群成员", "Members")}</span>
                <input
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setPage(0);
                  }}
                  placeholder={tx("搜索联系人或 Agent", "Search contacts or agents")}
                  type="search"
                  value={query}
                />
              </label>

              <div className="channel-picker__toolbar">
                <div className="channel-picker__summary">
                  <strong>{tx("可选成员", "Available members")}</strong>
                  <span>
                    {tx(
                      `${pageFirst}-${pageLast} / ${filteredCandidates.length}`,
                      `${pageFirst}-${pageLast} of ${filteredCandidates.length}`,
                    )}
                  </span>
                </div>
                {pageCount > 1 ? (
                  <div className="channel-picker__pager" aria-label={tx("成员分页", "Member pagination")}>
                    <button
                      aria-label={tx("上一页", "Previous page")}
                      className="channel-picker__pager-button"
                      disabled={safePage === 0}
                      onClick={() => setPage((current) => Math.max(0, current - 1))}
                      type="button"
                    >
                      <AppIcon name="arrowLeft" />
                    </button>
                    <span className="channel-picker__page-label">
                      {tx(`${safePage + 1} / ${pageCount}`, `${safePage + 1} / ${pageCount}`)}
                    </span>
                    <button
                      aria-label={tx("下一页", "Next page")}
                      className="channel-picker__pager-button"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                      type="button"
                    >
                      <AppIcon className="channel-picker__pager-icon--next" name="arrowLeft" />
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="channel-picker__list">
                {visibleCandidates.length > 0 ? (
                  visibleCandidates.map((candidate) => {
                    const selected = selectedIds.includes(candidate.id);
                    return (
                      <button
                        className={`channel-member-row${selected ? " channel-member-row--selected" : ""}`}
                        key={candidate.id}
                        onClick={() =>
                          setSelectedIds((current) =>
                            current.includes(candidate.id)
                              ? current.filter((id) => id !== candidate.id)
                              : [...current, candidate.id],
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
                  <EmptyState title={tx("没有匹配成员", "No matching members")} />
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
                    <div className="channel-member-row channel-member-row--static" key={candidate.id}>
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
          <button className="modal-secondary-button" onClick={onClose} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={pending || selectedCandidates.length === 0} type="submit">
            {pending ? tx("创建中...", "Creating...") : tx("创建", "Create")}
          </button>
        </div>
      </form>
    </div>
  );
}
