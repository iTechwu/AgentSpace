// AgentDetail 知识页选择弹窗（从 agent-detail.tsx 拆出，3.4-2）：
// 按标题/标签过滤可分配知识页并选择。

import { useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import type { WorkspaceAgentRecord } from "@/features/dashboard/data";

export function KnowledgePickerModal({
  pages,
  pending,
  onCancel,
  onSelect,
}: {
  readonly pages: NonNullable<WorkspaceAgentRecord["knowledge"]>["assignablePages"];
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSelect: (pageId: string) => void;
}) {
  const { tx } = useLanguage();
  const [query, setQuery] = useState("");
  const filteredPages = pages.filter((page) => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalizedQuery) {
      return true;
    }
    const haystack = `${page.title} ${page.tags.join(" ")}`.toLocaleLowerCase("zh-CN");
    return haystack.includes(normalizedQuery);
  });

  return (
    <div className="knowledge-modal-overlay" onClick={onCancel}>
      <div className="knowledge-modal" onClick={(event) => event.stopPropagation()}>
        <h3>{tx("添加知识", "Add knowledge")}</h3>
        <input
          className="knowledge-modal__input"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={tx("搜索知识页", "Search knowledge pages")}
          value={query}
        />
        <div className="knowledge-import-list">
          {filteredPages.map((page) => (
            <button
              className="knowledge-import-item"
              disabled={pending}
              key={page.id}
              onClick={() => onSelect(page.id)}
              type="button"
            >
              <strong>{page.title}</strong>
              <span>{page.tags.length > 0 ? page.tags.join(", ") : tx("无标签", "No tags")}</span>
            </button>
          ))}
          {filteredPages.length === 0 ? (
            <div className="knowledge-viewer__meta">
              {tx("没有匹配知识页。", "No matching knowledge pages.")}
            </div>
          ) : null}
        </div>
        <div className="knowledge-modal__footer">
          <button className="knowledge-btn knowledge-btn--ghost" onClick={onCancel} type="button">
            {tx("关闭", "Close")}
          </button>
        </div>
      </div>
    </div>
  );
}
