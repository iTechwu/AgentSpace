// 知识页树节点：原 knowledge-page-client.tsx 文件内堆叠的递归子组件，
// 抽出便于单元测试与代码导航；自包含（状态仅 expanded，所有外部依赖通过 props 传入）。
"use client";

import { useState } from "react";
import type { KnowledgePage } from "@dofe-agent/domain/workspace";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";

export function KnowledgeTreeNode({
  page,
  allPages,
  selectedId,
  depth,
  onSelect,
  onAddChild,
}: {
  page: KnowledgePage;
  allPages: KnowledgePage[];
  selectedId: string | null;
  depth: number;
  onSelect: (page: KnowledgePage) => void;
  onAddChild: (parentId: string) => void;
}) {
  const { tx } = useLanguage();
  const [expanded, setExpanded] = useState(true);
  const children = allPages
    .filter((candidate) => candidate.parentId === page.id)
    .sort((left, right) => left.sortOrder - right.sortOrder);

  return (
    <div className="knowledge-tree__branch">
      <div
        className={`knowledge-tree__node${selectedId === page.id ? " knowledge-tree__node--selected" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {children.length > 0 ? (
          <button
            aria-label={expanded ? tx(`收起 ${page.title}`, `Collapse ${page.title}`) : tx(`展开 ${page.title}`, `Expand ${page.title}`)}
            className="knowledge-tree__toggle"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <AppIcon name="chevronDown" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }} />
          </button>
        ) : (
          <span className="knowledge-tree__leaf">·</span>
        )}
        <button
          className="knowledge-tree__label"
          onClick={() => onSelect(page)}
          type="button"
        >
          {page.title}
        </button>
        <button
          aria-label={tx(`在 ${page.title} 下创建子页面`, `Create a child page under ${page.title}`)}
          className="knowledge-tree__add-child"
          onClick={(event) => {
            event.stopPropagation();
            onAddChild(page.id);
          }}
          type="button"
        >
          <AppIcon name="plus" />
        </button>
      </div>
      {expanded && children.length > 0 ? (
        <div className="knowledge-tree__children">
          {children.map((child) => (
            <KnowledgeTreeNode
              key={child.id}
              page={child}
              allPages={allPages}
              selectedId={selectedId}
              depth={depth + 1}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}