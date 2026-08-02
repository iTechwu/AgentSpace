"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TemplatesPageData } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { Template, TemplateCategory } from "@dofe-agent/domain/workspace";
import { createTemplateAction, updateTemplateAction, deleteTemplateAction } from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";

const CATEGORY_OPTIONS: Array<{ value: TemplateCategory; label: string; labelEn: string }> = [
  { value: "channel", label: "群组模板", labelEn: "Group" },
  { value: "task", label: "任务模板", labelEn: "Task" },
  { value: "skill", label: "技能模板", labelEn: "Skill" },
  { value: "workflow", label: "工作流模板", labelEn: "Workflow" },
];

export function TemplatesPageClient({ data, onDataChanged }: { data: TemplatesPageData; onDataChanged?: () => void }) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editConfigJson, setEditConfigJson] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createCategory, setCreateCategory] = useState<TemplateCategory>("task");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const selected = data.templates.find((t) => t.id === selectedId);

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    if (!selected) {
      setMobilePane("list");
    }
  }, [isCompactLayout, selected]);

  function openTemplate(template: Template): void {
    setSelectedId(template.id);
    setEditMode(false);
    setEditName(template.name);
    setEditDescription(template.description);
    setEditConfigJson(template.configJson);
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function startEdit(): void {
    if (!selected) return;
    setEditName(selected.name);
    setEditDescription(selected.description);
    setEditConfigJson(selected.configJson);
    setEditMode(true);
  }

  function saveEdit(): void {
    if (!selected) return;
    startTransition(async () => {
      await updateTemplateAction(selected.id, {
        name: editName.trim() || selected.name,
        description: editDescription.trim(),
        configJson: editConfigJson,
      });
      setEditMode(false);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleCreate(): void {
    if (!createName.trim()) return;
    startTransition(async () => {
      await createTemplateAction({
        category: createCategory,
        name: createName.trim(),
        description: createDescription.trim(),
        configJson: "{}",
      });
      setShowCreateModal(false);
      setCreateName("");
      setCreateDescription("");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteTemplateAction(id);
      if (selectedId === id) {
        setSelectedId(null);
        setEditMode(false);
      }
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  const grouped = CATEGORY_OPTIONS.map((cat) => ({
    ...cat,
    templates: data.templates.filter((t) => t.category === cat.value),
  })).filter((cat) => cat.templates.length > 0);
  const showListPane = !isCompactLayout || mobilePane === "list";
  const showDetailPane = !isCompactLayout || mobilePane === "detail";

  return (
    <section className="page-shell templates-page">
      <div className={`templates-layout${isCompactLayout ? " templates-layout--compact" : ""}`}>
      {showListPane ? (
        <div className="templates-sidebar">
        <div className="templates-sidebar__header">
          <h2>{tx("模板", "Templates")}</h2>
          <button
            aria-label={tx("创建模板", "Create template")}
            className="knowledge-btn knowledge-btn--primary"
            onClick={() => {
              setCreateName("");
              setCreateDescription("");
              setShowCreateModal(true);
            }}
            type="button"
          >
            <AppIcon name="plus" />
          </button>
        </div>
        <div className="templates-sidebar__count">
          {tx(
            `${data.totalCount} 个模板（${data.builtInCount} 内置 / ${data.customCount} 自建）`,
            `${data.totalCount} templates (${data.builtInCount} built-in / ${data.customCount} custom)`,
          )}
        </div>
        <div className="templates-sidebar__list">
          {grouped.length > 0 ? (
            grouped.map((group) => (
              <div className="templates-sidebar__group" key={group.value}>
                <h4 className="templates-sidebar__group-label">{tx(group.label, group.labelEn)}</h4>
                {group.templates.map((template) => (
                  <button
                    className={`templates-sidebar__item${selectedId === template.id ? " templates-sidebar__item--selected" : ""}`}
                    key={template.id}
                    onClick={() => openTemplate(template)}
                    type="button"
                  >
                    <strong>{template.name}</strong>
                    {template.builtIn ? (
                      <span className="templates-sidebar__badge">{tx("内置", "Built-in")}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <EmptyState
              actionLabel={tx("创建模板", "Create template")}
              body={tx("把常用的群组、任务、技能或工作流配置沉淀成模板。", "Turn common channel, task, skill, or workflow setups into reusable templates.")}
              eyebrow={tx("模板库", "Template library")}
              onAction={() => {
                setCreateName("");
                setCreateDescription("");
                setShowCreateModal(true);
              }}
              title={tx("还没有模板", "No templates yet")}
              variant="warm"
            />
          )}
        </div>
        </div>
      ) : null}

      {showDetailPane ? (
        <div className="templates-content">
        {isCompactLayout && selected ? (
          <div className="knowledge-mobile-bar">
            <button
              aria-label={tx("返回模板列表", "Back to templates")}
              className="knowledge-mobile-bar__back"
              onClick={() => setMobilePane("list")}
              type="button"
            >
              <AppIcon name="arrowLeft" />
            </button>
            <div className="knowledge-mobile-bar__copy">
              <strong>{selected.name}</strong>
              <span>{editMode ? tx("编辑模板", "Editing template") : tx("模板详情", "Template details")}</span>
            </div>
          </div>
        ) : null}
        {selected ? (
          editMode ? (
            <div className="knowledge-editor">
              <div className="knowledge-editor__toolbar">
                <input
                  className="knowledge-editor__title-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={tx("模板名称", "Template name")}
                />
                <div className="knowledge-editor__btns">
                  <button
                    className="knowledge-btn knowledge-btn--primary"
                    disabled={isPending}
                    onClick={saveEdit}
                    type="button"
                  >
                    {tx("保存", "Save")}
                  </button>
                  <button
                    className="knowledge-btn knowledge-btn--ghost"
                    onClick={() => setEditMode(false)}
                    type="button"
                  >
                    {tx("取消", "Cancel")}
                  </button>
                </div>
              </div>
              <input
                className="knowledge-modal__input"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder={tx("描述", "Description")}
              />
              <textarea
                className="knowledge-editor__content"
                value={editConfigJson}
                onChange={(e) => setEditConfigJson(e.target.value)}
                placeholder={tx("模板配置 JSON", "Template config JSON")}
              />
            </div>
          ) : (
            <div className="knowledge-viewer">
              <div className="knowledge-viewer__header">
                <h1>{selected.name}</h1>
                <div className="knowledge-viewer__actions">
                  {!selected.builtIn ? (
                    <>
                      <button
                        className="knowledge-btn knowledge-btn--primary"
                        onClick={startEdit}
                        type="button"
                      >
                        {tx("编辑", "Edit")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--danger"
                        disabled={isPending}
                        onClick={() => handleDelete(selected.id)}
                        type="button"
                      >
                        {tx("删除", "Delete")}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="knowledge-viewer__tags">
                <span className="knowledge-tag">
                  {CATEGORY_OPTIONS.find((c) => c.value === selected.category)?.label ?? selected.category}
                </span>
                {selected.builtIn ? <span className="knowledge-tag">{tx("内置", "Built-in")}</span> : null}
              </div>
              {selected.description ? (
                <div className="knowledge-viewer__meta">{selected.description}</div>
              ) : null}
              <div className="knowledge-viewer__body">
                <pre className="knowledge-viewer__markdown">{selected.configJson}</pre>
              </div>
            </div>
          )
        ) : (
          <EmptyState
            body={tx("从左侧选择一个模板，查看配置、说明以及是否需要继续编辑。", "Select a template to inspect its config, description, and whether it needs another revision.")}
            eyebrow={tx("模板详情", "Template detail")}
            title={tx("等待选择模板", "Choose a template")}
            variant="cool"
          />
        )}
        </div>
      ) : null}

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{tx("新建模板", "New Template")}</h3>
            <div className="automations-create__row">
              <label>{tx("类型", "Category")}</label>
              <select
                className="tables-create__col-type"
                value={createCategory}
                onChange={(e) => setCreateCategory(e.target.value as TemplateCategory)}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {tx(c.label, c.labelEn)}
                  </option>
                ))}
              </select>
            </div>
            <input
              autoFocus
              className="knowledge-modal__input"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
              placeholder={tx("模板名称", "Template name")}
            />
            <input
              className="knowledge-modal__input"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder={tx("描述（可选）", "Description (optional)")}
            />
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createName.trim()}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </section>
  );
}
