// 知识页文件解析任务面板：原 knowledge-page-client.tsx 文件内堆叠的子组件，
// 抽出便于单元测试与代码导航；与父组件无跨文件状态依赖。
"use client";

import { useLanguage } from "@/features/i18n/language-provider";
import type { KnowledgeParseTask } from "@/features/dashboard/data";
import type { KnowledgePage } from "@dofe-agent/domain/workspace";

export function ParseTaskPanel({
  isUploading,
  parseTasks,
  uploadError,
  onSelectPage,
}: {
  isUploading: boolean;
  parseTasks: KnowledgeParseTask[];
  uploadError: string | null;
  onSelectPage: (page: KnowledgePage) => void;
}) {
  const { tx } = useLanguage();
  return (
    <section className="knowledge-parse-panel" aria-label={tx("文件解析任务", "File parse tasks")}>
      <div className="knowledge-parse-panel__header">
        <strong>{tx("文件解析任务", "File parse tasks")}</strong>
        {isUploading ? <span>{tx("上传中…", "Uploading…")}</span> : null}
      </div>
      {uploadError ? (
        <div className="knowledge-parse-panel__error" role="alert">
          {uploadError}
        </div>
      ) : null}
      <ul className="knowledge-parse-panel__list">
        {parseTasks.map((task) => (
          <li className="knowledge-parse-panel__item" key={task.id}>
            <div className="knowledge-parse-panel__name">{task.fileName}</div>
            <div className="knowledge-parse-panel__meta">
              <span className={`knowledge-parse-panel__status knowledge-parse-panel__status--${task.status}`}>
                {parseTaskStatusLabel(task.status, tx)}
              </span>
              <span>
                {task.intent === "auto_deposit"
                  ? tx("自动沉淀为知识页", "Auto-deposit to knowledge page")
                  : tx("仅解析，沉淀由你决定", "Parse only, deposit manually")}
              </span>
              {task.lastErrorMessage ? (
                <span className="knowledge-parse-panel__error">{task.lastErrorMessage}</span>
              ) : null}
            </div>
            {task.status === "completed" && task.linkedKnowledgePageId ? (
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => onSelectPage({ id: task.linkedKnowledgePageId! } as unknown as KnowledgePage)}
                type="button"
              >
                {tx("打开知识页", "Open knowledge page")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function parseTaskStatusLabel(
  status: KnowledgeParseTask["status"],
  tx: (zh: string, en: string) => string,
): string {
  switch (status) {
    case "pending":
      return tx("排队中", "Queued");
    case "approved":
      return tx("已批准", "Approved");
    case "running":
      return tx("解析中", "Parsing");
    case "completed":
      return tx("解析完成", "Parsed");
    case "failed":
      return tx("解析失败", "Parse failed");
    case "cancelled":
      return tx("已取消", "Cancelled");
    default:
      return status;
  }
}