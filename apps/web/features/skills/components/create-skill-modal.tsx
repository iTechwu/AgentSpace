import { SYSTEM_AGENT_TEMPLATE_PRESETS, type AgentTemplateSkillRecommendation } from "@dofe-agent/domain";
import { useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { getField } from "@/shared/lib/form";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { AppIcon } from "@/shared/ui/app-icon";

interface CreateSkillModalProps {
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (input: { name: string; description: string }) => void;
  readonly onImportPreset?: (input: { url: string; conflict: "rename" }) => void;
  readonly onImportGitHub?: (input: {
    url: string;
    conflict: "reject" | "rename" | "replace" | "skip";
  }) => void;
}

export function CreateSkillModal({
  pending,
  onCancel,
  onConfirm,
  onImportPreset,
  onImportGitHub,
}: CreateSkillModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const [mode, setMode] = useState<"preset" | "github" | "blank">("preset");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "finance" | "product" | "design">("all");
  const [draft, setDraft] = useState({ name: "", description: "" });
  const skillPresets = useMemo(() => buildSkillPresetCards(), []);
  const filteredPresets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return skillPresets.filter((preset) => {
      if (category !== "all" && preset.category !== category) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        preset.label,
        preset.key,
        preset.description,
        preset.templateName,
        preset.sourceType,
        preset.searchTerms.join(" "),
      ].join(" ").toLocaleLowerCase("zh-CN");
      return haystack.includes(normalizedQuery);
    });
  }, [category, query, skillPresets]);
  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        className="modal-card modal-card--skill-create"
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "preset") {
            return;
          }
          const formData = new FormData(event.currentTarget);
          if (mode === "github") {
            onImportGitHub?.({
              url: getField(formData, "githubUrl"),
              conflict: getField(formData, "conflict") as "reject" | "rename" | "replace" | "skip",
            });
            return;
          }
          onConfirm({
            name: getField(formData, "name"),
            description: getField(formData, "description"),
          });
        }}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("创建 Skill", "Create skill")}</h3>
            <p id={descriptionId}>{tx("从预设市场或 GitHub 导入，也可以创建一个空白 Skill。", "Import from the preset marketplace or GitHub, or create a blank skill.")}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">
            <AppIcon name="close" />
          </button>
        </div>
        <div className="modal-card__body">
          <div className="agent-create-mode" role="tablist" aria-label={tx("创建方式", "Creation mode")}>
            <button
              aria-selected={mode === "preset"}
              className={`agent-create-mode__button${mode === "preset" ? " agent-create-mode__button--active" : ""}`}
              onClick={() => setMode("preset")}
              role="tab"
              type="button"
            >
              {tx("预设市场", "Preset marketplace")}
            </button>
            <button
              aria-selected={mode === "github"}
              className={`agent-create-mode__button${mode === "github" ? " agent-create-mode__button--active" : ""}`}
              onClick={() => setMode("github")}
              role="tab"
              type="button"
            >
              GitHub {tx("导入", "Import")}
            </button>
            <button
              aria-selected={mode === "blank"}
              className={`agent-create-mode__button${mode === "blank" ? " agent-create-mode__button--active" : ""}`}
              onClick={() => setMode("blank")}
              role="tab"
              type="button"
            >
              {tx("空白创建", "Blank custom")}
            </button>
          </div>

          {mode === "preset" ? (
            <div className="skill-preset-market" aria-label={tx("Skill 预设市场", "Skill preset marketplace")}>
              <div className="agent-template-market__toolbar">
                <div className="agent-template-market__tabs" aria-label={tx("预设分类", "Preset categories")} role="tablist">
                  {([
                    ["all", tx("全部", "All")],
                    ["finance", tx("金融", "Finance")],
                    ["product", tx("产品", "Product")],
                    ["design", tx("设计", "Design")],
                  ] as const).map(([value, label]) => (
                    <button
                      aria-selected={category === value}
                      className={`agent-template-market__tab${category === value ? " agent-template-market__tab--active" : ""}`}
                      key={value}
                      onClick={() => setCategory(value)}
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
                    aria-label={tx("搜索 Skill 预设", "Search skill presets")}
                    autoFocus
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={tx("搜索 Skill 名称、来源或标签", "Search skill name, source, or tag")}
                    type="search"
                    value={query}
                  />
                </label>
              </div>
              <div className="skill-preset-market__grid">
                {filteredPresets.map((preset) => (
                  <article className="skill-preset-market-card" key={preset.key}>
                    <div className="skill-preset-market-card__header">
                      <span className="skill-preset-market-card__avatar">
                        <AppIcon name={iconForSkillPresetCategory(preset.category)} />
                      </span>
                      <div>
                        <strong>{preset.label}</strong>
                        <span>{preset.sourceType} · {preset.templateName}</span>
                      </div>
                    </div>
                    <p>{preset.description}</p>
                    <div className="skill-preset-market-card__footer">
                      <span>{translatePresetCategory(preset.category, tx)}</span>
                      <button
                        className="modal-secondary-button"
                        disabled={pending}
                        onClick={() => {
                          if (onImportPreset) {
                            onImportPreset({ url: preset.sourceUrl, conflict: "rename" });
                            return;
                          }
                          setDraft({ name: preset.key, description: preset.description });
                          setMode("blank");
                        }}
                        type="button"
                      >
                        {onImportPreset ? tx("导入预设", "Import preset") : tx("使用预设", "Use preset")}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {filteredPresets.length === 0 ? (
                <div className="agent-template-market__empty">
                  {tx("没有匹配的 Skill 预设。", "No matching skill presets.")}
                </div>
              ) : null}
            </div>
          ) : mode === "github" ? (
            <div className="skill-github-import" aria-label={tx("从 GitHub 导入 Skill", "Import skill from GitHub")}>
              <label className="form-field">
                <span>GitHub URL</span>
                <input
                  aria-label="GitHub URL"
                  autoFocus
                  name="githubUrl"
                  placeholder="https://github.com/owner/repository/tree/main/skills/my-skill"
                  required
                  type="url"
                />
                <small className="form-field__hint">
                  {tx("粘贴包含 SKILL.md 的 GitHub tree、blob 或 raw 链接。", "Paste a GitHub tree, blob, or raw link that contains SKILL.md.")}
                </small>
              </label>
              <label className="form-field">
                <span>{tx("冲突策略", "Conflict strategy")}</span>
                <select defaultValue="rename" name="conflict">
                  <option value="reject">{tx("拒绝导入", "Reject import")}</option>
                  <option value="rename">{tx("自动重命名", "Rename imported skill")}</option>
                  <option value="replace">{tx("替换现有 Skill", "Replace existing skill")}</option>
                  <option value="skip">{tx("已存在则跳过", "Skip existing skill")}</option>
                </select>
              </label>
            </div>
          ) : (
            <>
              <label className="form-field">
                <span>{tx("Skill 名称", "Skill name")}</span>
                <input
                  autoFocus
                  name="name"
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="e.g. code-review"
                  type="text"
                  value={draft.name}
                />
              </label>
              <label className="form-field">
                <span>Description</span>
                <input
                  name="description"
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder={tx("Skill 用途", "Skill purpose")}
                  type="text"
                  value={draft.description}
                />
              </label>
            </>
          )}
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {tx("取消", "Cancel")}
          </button>
          {mode === "github" ? (
            <button className="primary-button" disabled={pending || !onImportGitHub} type="submit">
              {pending ? tx("导入中...", "Importing...") : tx("从 GitHub 导入", "Import from GitHub")}
            </button>
          ) : mode === "blank" ? (
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? tx("创建中...", "Creating...") : tx("创建", "Create")}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

interface SkillPresetCard {
  key: string;
  label: string;
  category: "finance" | "product" | "design";
  templateName: string;
  sourceType: AgentTemplateSkillRecommendation["sourceType"];
  sourceUrl: string;
  description: string;
  searchTerms: string[];
}

function buildSkillPresetCards(): SkillPresetCard[] {
  return SYSTEM_AGENT_TEMPLATE_PRESETS.flatMap((template) =>
    template.skillRecommendations.map((recommendation) => ({
      key: recommendation.key,
      label: recommendation.label,
      category: template.category,
      templateName: template.displayName,
      sourceType: recommendation.sourceType,
      sourceUrl: recommendation.sourceUrl,
      description: recommendation.description,
      searchTerms: recommendation.searchTerms,
    })),
  );
}

function translatePresetCategory(
  category: SkillPresetCard["category"],
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

function iconForSkillPresetCategory(category: SkillPresetCard["category"]): "costs" | "taskBoard" | "templates" {
  if (category === "finance") {
    return "costs";
  }
  if (category === "product") {
    return "taskBoard";
  }
  return "templates";
}
