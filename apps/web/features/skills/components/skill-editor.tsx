import { useEffect, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import type { SkillsPageData } from "@/features/dashboard/data";

interface SkillEditorProps {
  readonly assignedAgentCount: number;
  readonly assignedAgents: SkillsPageData["agents"];
  readonly file: SkillsPageData["skills"][number]["files"][number];
  readonly pending: boolean;
  readonly skill: SkillsPageData["skills"][number];
  readonly onDeleteSkill: () => void;
  readonly onSaveSkill: (input: { name: string; content: string }) => void;
}

export function SkillEditor({
  assignedAgentCount,
  assignedAgents,
  file,
  pending,
  skill,
  onDeleteSkill,
  onSaveSkill,
}: SkillEditorProps) {
  const { tx } = useLanguage();
  const [nameDraft, setNameDraft] = useState(skill.name);
  const [contentDraft, setContentDraft] = useState(file.content);

  useEffect(() => {
    setNameDraft(skill.name);
  }, [skill.id, skill.name]);

  useEffect(() => {
    setContentDraft(file.content);
  }, [file.id, file.content]);

  const isSkillDirty = nameDraft !== skill.name || contentDraft !== file.content;
  const dependencies = readSkillDependencies(skill.configJson);
  const requirements = readSkillRequirements(skill.configJson);

  return (
    <div className="skills-editor">
      <div className="skills-editor__header">
        <div className="skills-editor__identity">
          <div className="skills-editor__icon">✦</div>
          <div className="skills-editor__meta">
            <input
              className="skill-editor-input skill-editor-input--title"
              disabled={skill.isBuiltin}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              placeholder="Skill name"
              type="text"
              value={nameDraft}
            />
          </div>
        </div>
        <div className="skills-editor__actions">
          <button className="modal-secondary-button" disabled={pending || skill.isBuiltin} onClick={onDeleteSkill} type="button">
            {tx("删除 Skill", "Delete skill")}
          </button>
          <button
            className="primary-button"
            disabled={pending || skill.isBuiltin || nameDraft.trim().length === 0 || !isSkillDirty}
            onClick={() => onSaveSkill({ name: nameDraft, content: contentDraft })}
            type="button"
          >
            {tx("保存 Skill", "Save skill")}
          </button>
        </div>
      </div>

      <textarea
        className="skills-editor__textarea"
        disabled={skill.isBuiltin}
        onChange={(event) => setContentDraft(event.currentTarget.value)}
        placeholder={tx("编辑文件内容", "Edit file content")}
        rows={24}
        value={contentDraft}
      />

      {dependencies.length > 0 ? (
        <div className="skills-editor__dependencies" aria-label={tx("Skill 依赖", "Skill dependencies")}>
          <span>{tx("依赖", "Dependencies")}</span>
          <div>
            {dependencies.map((dependency) => (
              <code key={`${dependency.manager}:${dependency.name}@${dependency.version}`}>
                {dependency.manager}:{dependency.name}{dependency.manager === "npm" ? "@" : "=="}{dependency.version}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      {requirements.length > 0 ? (
        <div className="skills-editor__requirements" aria-label={tx("Skill 安装要求", "Skill installation requirements")}>
          <span>{tx("安装要求", "Install requirements")}</span>
          <div>
            {requirements.map((requirement) => (
              <code key={`${requirement.kind}:${requirement.value}`}>{formatRequirement(requirement)}</code>
            ))}
          </div>
        </div>
      ) : null}

      <div className="skills-editor__assigned">
        <div>
          <p className="skills-editor__assigned-label">{tx("已绑定 AI员工", "Assigned AI employees")}</p>
          <strong>{tx(`${assignedAgentCount} 个 AI员工 正在使用这份 skill`, `${assignedAgentCount} AI employees are using this skill`)}</strong>
        </div>
        <div className="skills-editor__assigned-list">
          {assignedAgents.length > 0 ? (
            assignedAgents.map((agent) => (
              <span className="skills-editor__assigned-pill" key={agent.id}>
                {agent.name}
              </span>
            ))
          ) : (
            <span className="skills-editor__assigned-pill skills-editor__assigned-pill--muted">{tx("还没有 AI员工 绑定", "No AI employees assigned yet")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function readSkillRequirements(configJson: string | undefined): Array<{ kind: string; value: string }> {
  if (!configJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(configJson) as { requirements?: unknown };
    return Array.isArray(parsed.requirements)
      ? parsed.requirements.filter((value): value is { kind: string; value: string } => (
        Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof (value as { kind?: unknown }).kind === "string"
        && typeof (value as { value?: unknown }).value === "string"
      ))
      : [];
  } catch {
    return [];
  }
}

function formatRequirement(requirement: { kind: string; value: string }): string {
  return requirement.kind === "secret"
    ? `${requirement.value}: credential center`
    : `${requirement.kind}: ${requirement.value}`;
}

function readSkillDependencies(configJson: string | undefined): Array<{ manager: string; name: string; version: string }> {
  if (!configJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(configJson) as { dependencies?: unknown };
    return Array.isArray(parsed.dependencies)
      ? parsed.dependencies.filter((value): value is { manager: string; name: string; version: string } => (
        Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof (value as { manager?: unknown }).manager === "string"
        && typeof (value as { name?: unknown }).name === "string"
        && typeof (value as { version?: unknown }).version === "string"
      ))
      : [];
  } catch {
    return [];
  }
}
