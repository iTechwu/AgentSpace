"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createWorkspaceSkillAction,
  deleteWorkspaceSkillAction,
  importWorkspaceSkillFromUrlAction,
  updateWorkspaceSkillMetaAction,
  upsertWorkspaceSkillFileAction,
} from "@/features/skills/actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import { EmptyState } from "@/shared/ui/empty-state";
import { actionToastResult, runToastAction, successToast, type ActionToastResult } from "@/shared/lib/toast-action";
import { useResizablePane } from "@/shared/lib/use-resizable-pane";
import { useFeedbackToast } from "@/shared/ui/feedback-toast-provider";
import { SkillEditor } from "@/features/skills/components/skill-editor";
import { CreateSkillModal } from "@/features/skills/components/create-skill-modal";
import { ImportSkillModal } from "@/features/skills/components/import-skill-modal";
import type { SkillsPageData } from "@/features/dashboard/data";
import { AppIcon } from "@/shared/ui/app-icon";
import { PaneResizeHandle } from "@/shared/ui/pane-resize-handle";

export function SkillsPageClient({
  data,
  moduleSearchParams,
  onDataChanged,
}: {
  data: SkillsPageData;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const [activeSourceFilter, setActiveSourceFilter] = useState<"all" | "builtin" | "manual" | "github" | "skills.sh" | "clawhub" | "local">("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(data.skills[0]?.id ?? null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(data.skills[0]?.files[0]?.id ?? null);
  const [showCreateSkill, setShowCreateSkill] = useState(false);
  const [showImportSkill, setShowImportSkill] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"skills" | "editor">("skills");
  const [isPending, startTransition] = useTransition();
  const { pushToast } = useFeedbackToast();
  const skillsPaneResize = useResizablePane({
    cssVariableName: "--workspace-list-width",
    defaultWidth: 360,
    maxWidth: 620,
    minWidth: 300,
    storageKey: "dofe-agent.skills-list-width",
  });

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

  useEffect(() => {
    if (!selectedSkillId || !data.skills.some((skill) => skill.id === selectedSkillId)) {
      setSelectedSkillId(data.skills[0]?.id ?? null);
    }
  }, [data.skills, selectedSkillId]);

  const selectedSkill = data.skills.find((skill) => skill.id === selectedSkillId) ?? null;

  useEffect(() => {
    const firstFileId = selectedSkill?.files[0]?.id ?? null;
    if (!selectedFileId || !selectedSkill?.files.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(firstFileId);
    }
  }, [selectedFileId, selectedSkill]);

  const selectedFile = selectedSkill?.files.find((file) => file.id === selectedFileId) ?? null;
  const builtinSkills = useMemo(() => data.skills.filter((skill) => skill.isBuiltin), [data.skills]);
  const customSkills = useMemo(() => data.skills.filter((skill) => !skill.isBuiltin), [data.skills]);
  const importedSkills = useMemo(
    () => data.skills.filter((skill) => !skill.isBuiltin && skill.sourceType && skill.sourceType !== "manual"),
    [data.skills],
  );
  const filteredSkills = useMemo(() => {
    if (activeSourceFilter === "builtin") {
      return builtinSkills;
    }
    if (activeSourceFilter === "manual") {
      return customSkills.filter((skill) => !skill.sourceType || skill.sourceType === "manual");
    }
    if (activeSourceFilter === "github" || activeSourceFilter === "skills.sh" || activeSourceFilter === "clawhub" || activeSourceFilter === "local") {
      return importedSkills.filter((skill) => skill.sourceType === activeSourceFilter);
    }
    return data.skills;
  }, [activeSourceFilter, builtinSkills, customSkills, data.skills, importedSkills]);

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("skills");
      return;
    }

    if (!selectedSkill) {
      setMobilePane("skills");
      return;
    }

    if (!selectedFile) {
      setMobilePane("skills");
    }
  }, [isCompactLayout, mobilePane, selectedFile, selectedSkill]);
  const assignmentCountBySkill = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of data.agents) {
      for (const skillId of agent.skillIds) {
        counts.set(skillId, (counts.get(skillId) ?? 0) + 1);
      }
    }
    return counts;
  }, [data.agents]);
  const selectedAgents = useMemo(
    () => (selectedSkill ? data.agents.filter((agent) => agent.skillIds.includes(selectedSkill.id)) : []),
    [data.agents, selectedSkill],
  );

  function runAction<T>(work: () => Promise<ActionToastResult<T>>, onDone?: (result: T) => void): void {
    startTransition(async () => {
      await runToastAction({
        action: work,
        onSuccess: async (result) => {
          onDone?.(result);
          refreshWorkspaceModule(onDataChanged, router);
        },
        pushToast,
        tx,
      });
    });
  }

  function handleSelectSkill(skillId: string, fileId: string | null): void {
    setSelectedSkillId(skillId);
    setSelectedFileId(fileId);
    if (isCompactLayout) {
      setMobilePane("editor");
    }
  }

  const showSkillsPane = !isCompactLayout || mobilePane === "skills";
  const showEditorPane = !isCompactLayout || mobilePane === "editor";

  function renderSkillRow(skill: SkillsPageData["skills"][number]) {
    return (
      <button
        className={`skills-studio__skill-row${selectedSkillId === skill.id ? " skills-studio__skill-row--active" : ""}${skill.isBuiltin ? " skills-studio__skill-row--builtin" : ""}`}
        key={skill.id}
        onClick={() => handleSelectSkill(skill.id, skill.files[0]?.id ?? null)}
        type="button"
      >
        <div className="skills-studio__skill-icon">{skill.isBuiltin ? "◎" : "✦"}</div>
        <div className="skills-studio__skill-copy">
          <div className="skills-studio__skill-heading">
            <strong>{skill.name}</strong>
            <span className={`skills-studio__skill-badge${skill.isBuiltin ? " skills-studio__skill-badge--builtin" : ""}`}>
              {translateSkillSourceBadge(skill, tx)}
            </span>
          </div>
          <span>
            {skill.isBuiltin
              ? tx(`系统技能 · ${assignmentCountBySkill.get(skill.id) ?? 0} 个 Agent 绑定`, `System skill · ${assignmentCountBySkill.get(skill.id) ?? 0} agents assigned`)
              : tx(`${assignmentCountBySkill.get(skill.id) ?? 0} 个 Agent 绑定`, `${assignmentCountBySkill.get(skill.id) ?? 0} agents assigned`)}
          </span>
        </div>
      </button>
    );
  }

  function clearCreateSkillQuery(): void {
    const nextSearch = new URLSearchParams(searchParams.toString());
    nextSearch.delete("create");
    const nextQuery = nextSearch.toString();
    if (moduleSearchParams && typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
      window.history.replaceState(window.history.state, "", nextUrl);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return;
    }
    router.replace(nextQuery ? `/skills?${nextQuery}` : "/skills", { scroll: false });
  }

  useEffect(() => {
    if (searchParams.get("create") === "skill") {
      setShowCreateSkill(true);
    }
  }, [searchParams]);

  return (
    <section className="page-shell skills-page">
      {showCreateSkill ? (
        <CreateSkillModal
          pending={isPending}
          onCancel={() => {
            setShowCreateSkill(false);
            clearCreateSkillQuery();
          }}
          onConfirm={(input) =>
            runAction(
              () => createWorkspaceSkillAction(input),
              (result) => {
                setSelectedSkillId(result.skillId);
                setSelectedFileId(result.fileId);
                if (isCompactLayout) {
                  setMobilePane("editor");
                }
                setShowCreateSkill(false);
                clearCreateSkillQuery();
              },
            )
          }
          onImportPreset={(input) =>
            runAction(
              () => importWorkspaceSkillFromUrlAction(input),
              (result) => {
                setSelectedSkillId(result.skillId);
                setShowCreateSkill(false);
                clearCreateSkillQuery();
              },
            )
          }
          onImportGitHub={(input) =>
            runAction(
              () => importWorkspaceSkillFromUrlAction(input),
              (result) => {
                setSelectedSkillId(result.skillId);
                setShowCreateSkill(false);
                clearCreateSkillQuery();
              },
            )
          }
        />
      ) : null}

      {showImportSkill ? (
        <ImportSkillModal
          pending={isPending}
          onCancel={() => setShowImportSkill(false)}
          onConfirm={(input) =>
            runAction(
              () => importWorkspaceSkillFromUrlAction(input),
              (result) => {
                setSelectedSkillId(result.skillId);
                setShowImportSkill(false);
              },
            )
          }
        />
      ) : null}


      <div
        className={`skills-studio${isCompactLayout ? " skills-studio--compact" : ""}`}
        style={skillsPaneResize.paneStyle}
      >
        {showSkillsPane ? (
          <aside className="skills-studio__sidebar page-panel">
            <div className="panel-header">
              <div>
                <h3>{tx("技能库", "Skill Library")}</h3>
              </div>
              <div className="panel-header__actions skills-page__header-actions">
                <button
                  aria-label={tx("导入 Skill", "Import skill")}
                  className="action-button action-button--compact action-button--icon skills-page__import-button"
                  disabled={isPending}
                  onClick={() => setShowImportSkill(true)}
                  title={tx("导入 Skill", "Import skill")}
                  type="button"
                >
                  <AppIcon name="open" />
                </button>
                <button
                  className="skills-page__add-button"
                  disabled={isPending}
                  onClick={() => setShowCreateSkill(true)}
                  type="button"
                >
                  <AppIcon name="plus" />
                  <span>{tx("添加技能", "Add skill")}</span>
                </button>
              </div>
            </div>

            <div className="skills-toolbar">
              <div className="filter-row skills-toolbar__filters">
                {[
                  ["all", tx("全部", "All")],
                  ["builtin", tx("系统默认", "System")],
                  ["manual", tx("手动创建", "Manual")],
                  ["github", "GitHub"],
                  ["skills.sh", "skills.sh"],
                  ["clawhub", "ClawHub"],
                  ["local", tx("本地导入", "Local")],
                ].map(([value, label]) => (
                  <button
                    className={`filter-pill${activeSourceFilter === value ? " filter-pill--active" : ""}`}
                    key={value}
                    onClick={() => setActiveSourceFilter(value as "all" | "builtin" | "manual" | "github" | "skills.sh" | "clawhub" | "local")}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="skills-studio__list">
              {filteredSkills.length > 0 ? (
                <>
                  {builtinSkills.filter((skill) => filteredSkills.some((item) => item.id === skill.id)).length > 0 ? (
                    <div className="skills-studio__group">
                      <p className="skills-studio__group-label">{tx("系统默认技能", "System Default Skills")}</p>
                      <div className="skills-studio__group-list">
                        {builtinSkills.filter((skill) => filteredSkills.some((item) => item.id === skill.id)).map((skill) => renderSkillRow(skill))}
                      </div>
                    </div>
                  ) : null}
                  {customSkills.filter((skill) => filteredSkills.some((item) => item.id === skill.id)).length > 0 ? (
                    <div className="skills-studio__group">
                      <p className="skills-studio__group-label">{tx("一般技能", "General Skills")}</p>
                      <div className="skills-studio__group-list">
                        {customSkills.filter((skill) => filteredSkills.some((item) => item.id === skill.id)).map((skill) => renderSkillRow(skill))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState
                  actionLabel={tx("新建 Skill", "New skill")}
                  onAction={() => setShowCreateSkill(true)}
                  title={tx("Skill 库为空", "No skills yet")}
                />
              )}
            </div>
          </aside>
        ) : null}

        {!isCompactLayout && showSkillsPane && showEditorPane ? (
          <PaneResizeHandle
            label={tx("调整技能库列表宽度", "Resize skill library list")}
            maxValue={skillsPaneResize.maxWidth}
            minValue={skillsPaneResize.minWidth}
            onKeyDown={skillsPaneResize.onHandleKeyDown}
            onPointerDown={skillsPaneResize.onHandlePointerDown}
            value={skillsPaneResize.width}
          />
        ) : null}

        {showEditorPane ? (
          <section className="skills-studio__editor page-panel">
            {selectedSkill && selectedFile ? (
              <>
                {isCompactLayout ? (
                  <div className="skills-studio__mobile-bar">
                    <button
                      aria-label={tx("返回技能列表", "Back to skills")}
                      className="skills-studio__mobile-back"
                      onClick={() => setMobilePane("skills")}
                      type="button"
                    >
                      <AppIcon name="arrowLeft" />
                    </button>
                    <div className="skills-studio__mobile-copy">
                      <strong>{selectedSkill.name}</strong>
                      <span>{tx("Skill 内容", "Skill content")}</span>
                    </div>
                  </div>
                ) : null}

                <SkillEditor
                  assignedAgentCount={assignmentCountBySkill.get(selectedSkill.id) ?? 0}
                  assignedAgents={selectedAgents}
                  file={selectedFile}
                  pending={isPending}
                  skill={selectedSkill}
                  onDeleteSkill={() =>
                    runAction(
                      () => deleteWorkspaceSkillAction(selectedSkill.id),
                      () => {
                        setSelectedSkillId(null);
                        setSelectedFileId(null);
                        if (isCompactLayout) {
                          setMobilePane("skills");
                        }
                      },
                    )
                  }
                  onSaveSkill={(input) =>
                    runAction(
                      async () => {
                        let savedFileId = selectedFile.id;
                        if (input.name !== selectedSkill.name) {
                          await updateWorkspaceSkillMetaAction({
                            skillId: selectedSkill.id,
                            name: input.name,
                            description: selectedSkill.description,
                          });
                        }
                        if (input.content !== selectedFile.content) {
                          const result = await upsertWorkspaceSkillFileAction({
                            skillId: selectedSkill.id,
                            fileId: selectedFile.id,
                            path: selectedFile.path,
                            content: input.content,
                          });
                          savedFileId = result.data.fileId;
                        }

                        return actionToastResult({ fileId: savedFileId }, successToast("Skill 已保存。", "Skill saved."));
                      },
                      (result) => {
                        setSelectedFileId(result.fileId);
                      },
                    )
                  }
                />
              </>
            ) : (
              <EmptyState title={tx("未选择文件", "No file selected")} />
            )}
          </section>
        ) : null}
      </div>
    </section>
  );
}

function translateSkillSourceBadge(
  skill: SkillsPageData["skills"][number],
  tx: (zh: string, en: string) => string,
): string {
  if (skill.isBuiltin || skill.sourceType === "builtin") {
    return tx("系统默认", "System");
  }
  if (skill.sourceType === "github") {
    return "GitHub";
  }
  if (skill.sourceType === "skills.sh") {
    return "skills.sh";
  }
  if (skill.sourceType === "clawhub") {
    return "ClawHub";
  }
  if (skill.sourceType === "local") {
    return tx("本地", "Local");
  }
  return tx("工作区", "Workspace");
}
