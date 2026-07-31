"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import type { SkillsPageData } from "@/features/dashboard/data";
import MDEditor, { commands } from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";

interface SkillEditorProps {
  readonly assignedAgentCount: number;
  readonly assignedAgents: SkillsPageData["agents"];
  readonly canEditBuiltin: boolean;
  readonly file: SkillsPageData["skills"][number]["files"][number];
  readonly pending: boolean;
  readonly skill: SkillsPageData["skills"][number];
  readonly onDeleteSkill: () => void;
  readonly onSaveSkill: (input: { name: string; content: string }) => void;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  [key: string]: unknown;
}

export function SkillEditor({
  assignedAgentCount,
  assignedAgents,
  canEditBuiltin,
  file,
  pending,
  skill,
  onDeleteSkill,
  onSaveSkill,
}: SkillEditorProps) {
  const { tx } = useLanguage();
  const [nameDraft, setNameDraft] = useState(skill.name);
  const [contentDraft, setContentDraft] = useState(file.content);
  const [editorMode, setEditorMode] = useState<"preview" | "edit">("preview");

  useEffect(() => {
    setNameDraft(skill.name);
  }, [skill.id, skill.name]);

  useEffect(() => {
    setContentDraft(file.content);
  }, [file.id, file.content]);

  useEffect(() => {
    setEditorMode("preview");
  }, [file.id]);

  const isSkillDirty = nameDraft !== skill.name || contentDraft !== file.content;
  const isReadonly = skill.isBuiltin && !canEditBuiltin;

  const { bodyContent, frontmatter } = useMemo(
    () => parseSkillContent(file.content),
    [file.content],
  );

  const dependencies = readSkillDependencies(skill.configJson);
  const requirements = readSkillRequirements(skill.configJson);

  const fileName = file.path === "SKILL.md" ? "SKILL.md" : file.path;
  const hasFrontmatter = frontmatter !== null && Object.keys(frontmatter).filter(
    (k) => k !== "name" || frontmatter[k],
  ).length > 0;

  return (
    <div className="skills-editor">
      <div className="skills-editor__header">
        <div className="skills-editor__identity">
          <div className="skills-editor__icon">✦</div>
          <div className="skills-editor__meta">
            <input
              className="skill-editor-input skill-editor-input--title"
              disabled={isReadonly}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              placeholder="Skill name"
              type="text"
              value={nameDraft}
            />
            <span className="skills-editor__file-name">{fileName}</span>
          </div>
        </div>
        <div className="skills-editor__actions">
          {!isReadonly ? (
            <button
              className="modal-secondary-button"
              disabled={pending || skill.isBuiltin}
              onClick={() => onDeleteSkill()}
              type="button"
            >
              {tx("删除 Skill", "Delete skill")}
            </button>
          ) : null}
          <button
            className="modal-secondary-button"
            disabled={pending || isReadonly}
            onClick={() => setEditorMode(editorMode === "preview" ? "edit" : "preview")}
            type="button"
          >
            {isReadonly
              ? tx("只读预览", "Read-only preview")
              : editorMode === "preview"
                ? tx("编辑 Markdown", "Edit Markdown")
                : tx("预览 Markdown", "Preview Markdown")}
          </button>
          <button
            className="primary-button"
            disabled={pending || isReadonly || nameDraft.trim().length === 0 || !isSkillDirty}
            onClick={() => onSaveSkill({ name: nameDraft, content: contentDraft })}
            type="button"
          >
            {tx("保存 Skill", "Save skill")}
          </button>
        </div>
      </div>

      {hasFrontmatter ? (
        <div className="skills-editor__frontmatter">
          <span className="skills-editor__frontmatter-label">
            {tx("Skill 元数据", "Skill metadata")}
          </span>
          <div className="skills-editor__frontmatter-fields">
            {frontmatter?.name ? (
              <div className="skills-editor__frontmatter-field">
                <span className="skills-editor__frontmatter-key">名称</span>
                <code>{frontmatter.name}</code>
              </div>
            ) : null}
            {frontmatter?.description ? (
              <div className="skills-editor__frontmatter-field">
                <span className="skills-editor__frontmatter-key">描述</span>
                <span className="skills-editor__frontmatter-value">
                  {typeof frontmatter.description === "string"
                    ? frontmatter.description.replace(/\n/g, " ").replace(/\s+/g, " ").trim()
                    : String(frontmatter.description)}
                </span>
              </div>
            ) : null}
            {frontmatter?.tags && Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0 ? (
              <div className="skills-editor__frontmatter-field">
                <span className="skills-editor__frontmatter-key">标签</span>
                <div className="skills-editor__frontmatter-tags">
                  {frontmatter.tags.map((tag: string) => (
                    <code key={tag}>{tag}</code>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="skills-editor__md-container" data-color-mode="light">
        {editorMode === "edit" ? (
          <MDEditor
            commands={commands.getCommands()}
            height={520}
            onChange={(value) => setContentDraft(value ?? "")}
            preview="live"
            value={contentDraft}
            visibleDragbar={false}
          />
        ) : (
          <div className="skills-editor__md-preview">
            <MDEditor.Markdown
              source={bodyContent || tx("*（此 Skill 暂无内容）*", "*(This skill has no content yet)*")}
              style={{ minHeight: 120, padding: "16px 20px" }}
            />
          </div>
        )}
      </div>

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

function parseSkillContent(content: string): {
  frontmatter: SkillFrontmatter | null;
  bodyContent: string;
} {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!frontmatterMatch) {
    return { frontmatter: null, bodyContent: content };
  }

  const frontmatter: SkillFrontmatter = {};
  const lines = frontmatterMatch[1].split(/\r?\n/);
  let currentKey = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (/^\s/.test(line) && currentKey) {
      if (currentKey === "description" && typeof frontmatter.description === "string") {
        frontmatter.description += "\n" + line.trimStart();
      }
      continue;
    }

    if (line.trim().startsWith("-") && currentKey === "tags") {
      const tag = line.trim().replace(/^-\s*/, "").trim();
      if (tag) {
        if (!frontmatter.tags) frontmatter.tags = [];
        frontmatter.tags.push(tag);
      }
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;

    currentKey = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    if (!currentKey || !value) continue;

    if (value === ">" || value === "|" || value.startsWith(">-") || value.startsWith("|-")) {
      frontmatter[currentKey] = "";
      continue;
    }
    if (value === "" && (currentKey === "tags")) {
      frontmatter.tags = [];
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value.startsWith("[")) {
      frontmatter[currentKey] = value.slice(1, -1).split(",").map((s) => s.trim());
      continue;
    }

    frontmatter[currentKey] = value;
  }

  const bodyContent = content.slice(frontmatterMatch[0].length);

  return { frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null, bodyContent };
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
