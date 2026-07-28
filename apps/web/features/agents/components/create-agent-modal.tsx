import {
  SYSTEM_AGENT_TEMPLATE_PRESETS,
  resolveAgentTemplateSkillMatches,
  type AgentTemplateId,
  type SystemAgentTemplatePreset,
} from "@dofe-agent/domain";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import type { AgentsPageData } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";
import { ExecutionEngineSelect, resolveExecutionEngineValue } from "@/features/agents/components/execution-engine-select";
import { RuntimeModelPicker } from "@/features/runtimes/runtime-model-picker";
import { isDaemonProvider } from "@dofe-agent/domain";

interface CreateAgentModalProps {
  readonly containerOptions: AgentsPageData["containerOptions"];
  readonly defaultContainerId: string;
  readonly workspaceSkills: AgentsPageData["workspaceSkills"];
  readonly pending: boolean;
  readonly canCreate?: boolean;
  readonly requiresRuntime?: boolean;
  readonly emptyRuntimeMessage?: string;
  /** When provided (admin), the form offers a shortcut to create a new runtime. */
  readonly createRuntimeHref?: string;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    name: string;
    remarkName: string;
    summary: string;
    instructions: string;
    containerId: string;
    defaultModel?: string;
    templateId?: AgentTemplateId;
  }) => void;
}

type CreateMode = "template" | "blank";
type AgentTemplateCategoryFilter = "all" | SystemAgentTemplatePreset["category"];

export function CreateAgentModal({
  containerOptions,
  defaultContainerId,
  workspaceSkills,
  pending,
  canCreate = true,
  requiresRuntime = false,
  emptyRuntimeMessage,
  createRuntimeHref,
  onClose,
  onSubmit,
}: CreateAgentModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId } = useDialogSurface<HTMLFormElement>(onClose);
  const [containerId, setContainerId] = useState(() => resolveDefaultRuntimeId(defaultContainerId, containerOptions, requiresRuntime));
  const [createMode, setCreateMode] = useState<CreateMode>("template");
  const [selectedTemplateId, setSelectedTemplateId] = useState<AgentTemplateId>("finance-analyst");
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateCategory, setTemplateCategory] = useState<AgentTemplateCategoryFilter>("all");
  const selectedTemplate = useMemo(
    () => SYSTEM_AGENT_TEMPLATE_PRESETS.find((template) => template.id === selectedTemplateId) ?? SYSTEM_AGENT_TEMPLATE_PRESETS[0]!,
    [selectedTemplateId],
  );
  const filteredTemplates = useMemo(() => {
    const normalizedQuery = templateQuery.trim().toLocaleLowerCase("zh-CN");
    return SYSTEM_AGENT_TEMPLATE_PRESETS.filter((template) => {
      if (templateCategory !== "all" && template.category !== templateCategory) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        template.displayName,
        template.shortDescription,
        template.summary,
        template.fit,
        template.traits.join(" "),
        translateTemplateCategory(template.category, tx),
      ].join(" ").toLocaleLowerCase("zh-CN");
      return haystack.includes(normalizedQuery);
    });
  }, [templateCategory, templateQuery, tx]);
  const [draft, setDraft] = useState(() => createDraftFromTemplate(selectedTemplate));
  const skillMatches = useMemo(
    () => resolveAgentTemplateSkillMatches(selectedTemplate, workspaceSkills),
    [selectedTemplate, workspaceSkills],
  );
  const matchedSkillCount = skillMatches.filter((match) => Boolean(match.matchedSkill)).length;

  useEffect(() => {
    setContainerId(resolveDefaultRuntimeId(defaultContainerId, containerOptions, requiresRuntime));
  }, [containerOptions, defaultContainerId, requiresRuntime]);

  useEffect(() => {
    if (createMode === "template") {
      setDraft(createDraftFromTemplate(selectedTemplate));
    }
  }, [createMode, selectedTemplate]);

  const submitDisabled = pending || !canCreate || (requiresRuntime && !containerId);

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card modal-card--agent-create"
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (submitDisabled) {
            return;
          }
          onSubmit({
            name: draft.name,
            remarkName: draft.remarkName,
            summary: draft.summary,
            instructions: draft.instructions,
            containerId,
            defaultModel: draft.defaultModel || undefined,
            templateId: createMode === "template" ? selectedTemplate.id : undefined,
          });
          event.currentTarget.reset();
          setDraft(createMode === "template" ? createDraftFromTemplate(selectedTemplate) : createBlankDraft());
          setContainerId(resolveDefaultRuntimeId(defaultContainerId, containerOptions, requiresRuntime));
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("创建 AI员工", "Create AI employee")}</h3>
          </div>
          <button className="modal-close" onClick={onClose} type="button">
            <AppIcon name="close" />
          </button>
        </div>

        <div className="modal-card__body">
          <div className="agent-create-mode" role="tablist" aria-label={tx("创建方式", "Creation mode")}>
            <button
              aria-selected={createMode === "template"}
              className={`agent-create-mode__button${createMode === "template" ? " agent-create-mode__button--active" : ""}`}
              onClick={() => setCreateMode("template")}
              role="tab"
              type="button"
            >
              {tx("从模板创建", "Use template")}
            </button>
            <button
              aria-selected={createMode === "blank"}
              className={`agent-create-mode__button${createMode === "blank" ? " agent-create-mode__button--active" : ""}`}
              onClick={() => {
                setCreateMode("blank");
                setDraft(createBlankDraft());
              }}
              role="tab"
              type="button"
            >
              {tx("空白自定义", "Blank custom")}
            </button>
          </div>

          {createMode === "template" ? (
            <div className="agent-template-market" aria-label={tx("AI员工 模板市场", "AI employee template marketplace")}>
              <div className="agent-template-market__toolbar">
                <div className="agent-template-market__tabs" aria-label={tx("模板范围", "Template scope")} role="tablist">
                  {([
                    ["all", tx("全部", "All")],
                    ["finance", tx("金融", "Finance")],
                    ["product", tx("产品", "Product")],
                    ["design", tx("设计", "Design")],
                  ] as const).map(([value, label]) => (
                    <button
                      aria-selected={templateCategory === value}
                      className={`agent-template-market__tab${templateCategory === value ? " agent-template-market__tab--active" : ""}`}
                      key={value}
                      onClick={() => setTemplateCategory(value)}
                      role="tab"
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="agent-template-market__search">
                  <AppIcon name="search" />
                  <input
                    aria-label={tx("搜索 AI员工 模板", "Search AI employee templates")}
                    onChange={(event) => setTemplateQuery(event.target.value)}
                    placeholder={tx("搜索模板名称、能力或标签", "Search template name, capability, or tag")}
                    type="search"
                    value={templateQuery}
                  />
                </label>
              </div>
              <div className="agent-template-picker">
                {filteredTemplates.map((template) => {
                  const matches = resolveAgentTemplateSkillMatches(template, workspaceSkills);
                  const readyCount = matches.filter((match) => Boolean(match.matchedSkill)).length;
                  return (
                    <button
                      className={`agent-template-card${selectedTemplate.id === template.id ? " agent-template-card--active" : ""}`}
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      type="button"
                    >
                      <span className="agent-template-card__avatar">
                        <AppIcon name={iconForTemplateCategory(template.category)} />
                      </span>
                      <span className="agent-template-card__copy">
                        <span className="agent-template-card__category">{translateTemplateCategory(template.category, tx)}</span>
                        <strong>{template.displayName}</strong>
                        <small>{tx(`AI员工 模板 · ${template.defaultTitle}`, `AI employee template · ${template.defaultTitle}`)}</small>
                      </span>
                      <p>{template.shortDescription}</p>
                      <span className="agent-template-card__footer">
                        <span>{tx(`${readyCount}/${matches.length} 个预置技能`, `${readyCount}/${matches.length} preloaded skills`)}</span>
                        <span>{template.traits.slice(0, 2).join(" / ")}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {filteredTemplates.length === 0 ? (
                <div className="agent-template-market__empty">
                  {tx("没有匹配的 AI员工 模板。", "No matching agent templates.")}
                </div>
              ) : null}
            </div>
          ) : null}

          <label className="form-field">
            <span>Name</span>
            <input
              autoFocus
              name="name"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="e.g. Deep Research AI Employee"
              type="text"
              value={draft.name}
            />
          </label>
          <label className="form-field">
            <span>{tx("备注名", "Display name")}</span>
            <input
              name="remarkName"
              onChange={(event) => setDraft((current) => ({ ...current, remarkName: event.target.value }))}
              placeholder="e.g. Repo Builder"
              type="text"
              value={draft.remarkName}
            />
          </label>
          <label className="form-field">
            <span>Description</span>
            <input
              name="summary"
              onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
              placeholder={tx("简短摘要", "Short summary")}
              type="text"
              value={draft.summary}
            />
          </label>
          <label className="form-field">
            <span>Instructions</span>
            <textarea
              name="instructions"
              onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
              placeholder={tx("角色与规则", "Role and rules")}
              rows={createMode === "template" ? 8 : 4}
              value={draft.instructions}
            />
          </label>
          {createMode === "template" ? (
            <div className="agent-template-skill-panel">
              <div className="agent-template-skill-panel__header">
                <div>
                  <strong>{tx("预置技能", "Preloaded skills")}</strong>
                  <span>
                    {tx(
                      `已准备 ${matchedSkillCount}/${skillMatches.length} 个预置技能`,
                      `${matchedSkillCount}/${skillMatches.length} preloaded skills ready`,
                    )}
                  </span>
                </div>
              </div>
              <div className="agent-template-skill-list">
                {skillMatches.map((match) => (
                  <div className="agent-template-skill-row" key={match.recommendation.key}>
                    <div>
                      <strong>{match.recommendation.label}</strong>
                      <span>{match.recommendation.description}</span>
                    </div>
                    <div className="agent-template-skill-row__status">
                      <span className={`agent-template-skill-badge${match.matchedSkill ? " agent-template-skill-badge--matched" : ""}`}>
                        {match.matchedSkill ? tx("已预置", "Ready") : tx("创建时补齐", "Added on create")}
                      </span>
                      <span>{tx("系统预置", "System")}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="form-help">
                {tx(
                  "模板技能由系统预置并在创建时自动绑定，无需手动导入。",
                  "Template skills are preloaded by the system and bound automatically on create.",
                )}
              </p>
            </div>
          ) : null}
          <div className="form-field">
            <div className="form-field__label-row">
              <span>{tx("执行引擎", "Execution Engine")}</span>
              {createRuntimeHref ? (
                <a className="form-field__link" href={createRuntimeHref}>
                  {tx("＋ 创建新 Runtime", "＋ Create new runtime")}
                </a>
              ) : null}
            </div>
            <ExecutionEngineSelect
              label={tx("执行引擎", "Execution Engine")}
              name="containerId"
              onChange={setContainerId}
              options={containerOptions}
              emptyDescription={emptyRuntimeMessage}
              placeholder={tx("选择一个执行引擎", "Select an execution engine")}
              value={containerId}
            />
            <p className="form-help">
              {tx(
                "优先复用列表中标记“可复用”的受管 Runtime；一个 Runtime 可服务多个 AI员工。",
                "Prefer reusing managed runtimes marked “Reusable”; one runtime can serve multiple AI employees.",
              )}
            </p>
            {requiresRuntime && containerOptions.length === 0 ? (
              <p className="form-help">{emptyRuntimeMessage ?? tx("请联系管理员分配执行引擎。", "Ask an admin to assign an execution engine.")}</p>
            ) : null}
          </div>
          {(() => {
            const selectedContainer = containerOptions.find((option) => option.id === containerId);
            const provider = selectedContainer?.provider && isDaemonProvider(selectedContainer.provider)
              ? selectedContainer.provider
              : undefined;
            return provider ? (
              <div className="form-field">
                <RuntimeModelPicker
                  provider={provider}
                  value={draft.defaultModel}
                  onChange={(value) => setDraft((current) => ({ ...current, defaultModel: value }))}
                />
              </div>
            ) : (
              <div className="form-field">
                <label className="form-field">
                  <span>{tx("默认模型", "Default model")}</span>
                  <input
                    name="defaultModel"
                    onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}
                    placeholder={tx("继承 Runtime 默认模型", "Inherit runtime default model")}
                    type="text"
                    value={draft.defaultModel}
                  />
                </label>
              </div>
            );
          })()}
        </div>

        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onClose} type="button">
            {tx("取消", "Cancel")}
          </button>
          <button className="primary-button" disabled={submitDisabled} type="submit">
            {pending
              ? tx("创建中...", "Creating...")
              : createMode === "template"
                ? tx("从模板创建", "Create from template")
                : tx("创建", "Create")}
          </button>
        </div>
      </form>
    </div>
  );
}

function resolveDefaultRuntimeId(
  defaultContainerId: string,
  containerOptions: AgentsPageData["containerOptions"],
  requiresRuntime: boolean,
): string {
  return resolveExecutionEngineValue(defaultContainerId, containerOptions) || (requiresRuntime ? containerOptions[0]?.id ?? "" : "");
}

function createDraftFromTemplate(template: SystemAgentTemplatePreset): {
  name: string;
  remarkName: string;
  summary: string;
  instructions: string;
  defaultModel: string;
} {
  return {
    name: template.defaultAgentName,
    remarkName: template.defaultRemarkName,
    summary: template.summary,
    instructions: template.instructions,
    defaultModel: "",
  };
}

function createBlankDraft(): {
  name: string;
  remarkName: string;
  summary: string;
  instructions: string;
  defaultModel: string;
} {
  return {
    name: "",
    remarkName: "",
    summary: "",
    instructions: "",
    defaultModel: "",
  };
}

function translateTemplateCategory(
  category: SystemAgentTemplatePreset["category"],
  tx: (zh: string, en: string) => string,
): string {
  if (category === "finance") {
    return tx("金融", "Finance");
  }
  if (category === "product") {
    return tx("产品", "Product");
  }
  return tx("设计", "Design");
}

function iconForTemplateCategory(category: SystemAgentTemplatePreset["category"]): "costs" | "taskBoard" | "templates" {
  if (category === "finance") {
    return "costs";
  }
  if (category === "product") {
    return "taskBoard";
  }
  return "templates";
}
