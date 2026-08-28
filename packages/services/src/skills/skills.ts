import { type DofeAgentState, type WorkspaceSkill, type WorkspaceSkillFile } from "@dofe-agent/domain/workspace";
import {
  createStoredWorkspaceSkillSync,
  deleteStoredWorkspaceSkillFileSync,
  deleteStoredWorkspaceSkillSync,
  getDatabase,
  listStoredWorkspaceSkillsSync,
  readWorkspaceStateRecordSync,
  readStoredWorkspaceSkillSync,
  withTransaction,
  writeWorkspaceStateRecordSync,
  updateStoredWorkspaceSkillMetaSync,
  upsertStoredWorkspaceSkillFileSync,
} from "@dofe-agent/db";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { sameValue, createOpaqueId, normalizeSkillFilePath } from "../shared/helpers.ts";
import {
  createPredefinedAgentTemplateSkillRecords,
  createWorkspaceSkillRecord,
  ensureRequiredSkillFile,
  isPredefinedAgentTemplateSkillName,
  normalizeWorkspaceSkillFiles,
  normalizeWorkspaceState,
} from "../shared/normalizers.ts";

export const BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME = "return-output-files";
export const BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME = "workspace-context";
export const BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME = "update-channel-documents";

export function isSystemSkillName(name: string): boolean {
  return (
    sameValue(name, BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME)
    || sameValue(name, BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME)
    || sameValue(name, BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME)
    || isPredefinedAgentTemplateSkillName(name)
  );
}

export function listWorkspaceSkillsSync(workspaceId?: string): WorkspaceSkill[] {
  reconcileWorkspaceSkillStorageSync(workspaceId);
  return ensurePredefinedAgentTemplateSkillsSync(workspaceId);
}

export interface WorkspaceSkillStorageReconciliation {
  recoveredSkillIds: string[];
  canonicalSkillCount: number;
  snapshotUpdated: boolean;
}

export function reconcileWorkspaceSkillStorageSync(workspaceId?: string): WorkspaceSkillStorageReconciliation {
  const db = getDatabase();

  return withTransaction(db, () => {
    const state = readWorkspaceStateRecordSync(workspaceId);
    let storedSkills = listStoredWorkspaceSkillsSync(workspaceId);
    if (!state || !Array.isArray(state.skills) || state.skills.length === 0) {
      return {
        recoveredSkillIds: [],
        canonicalSkillCount: storedSkills.length,
        snapshotUpdated: false,
      };
    }

    const recoveredSkillIds: string[] = [];
    for (const snapshotSkill of state.skills) {
      if (findCanonicalStoredSkill(storedSkills, snapshotSkill)) {
        continue;
      }

      const recoveredSkill = createStoredWorkspaceSkillSync(snapshotSkill, workspaceId);
      storedSkills = [...storedSkills, recoveredSkill];
      recoveredSkillIds.push(recoveredSkill.id);
    }

    const canonicalSkills = listStoredWorkspaceSkillsSync(workspaceId);
    const snapshotUpdated = !sameSkillSnapshotSet(state.skills, canonicalSkills);
    if (snapshotUpdated) {
      const recoveryEntry = recoveredSkillIds.length > 0
        ? [{
            title: "Skill storage reconciled",
            note: `${recoveredSkillIds.length} Skill(s) were recovered from the workspace snapshot.`,
            code: "workspace.skill_storage_reconciled",
            data: {
              recoveredSkillCount: String(recoveredSkillIds.length),
            },
          }]
        : [];
      writeWorkspaceStateRecordSync({
        ...state,
        skills: canonicalSkills,
        ledger: [...recoveryEntry, ...state.ledger].slice(0, 200),
      }, workspaceId, { skipVersionCheck: true });
    }

    return {
      recoveredSkillIds,
      canonicalSkillCount: canonicalSkills.length,
      snapshotUpdated,
    };
  });
}

export function ensurePredefinedAgentTemplateSkillsSync(workspaceId?: string): WorkspaceSkill[] {
  let storedSkills = listStoredWorkspaceSkillsSync(workspaceId);
  let changed = false;

  for (const expectedSkill of createPredefinedAgentTemplateSkillRecords()) {
    const existingSkill = findPredefinedAgentTemplateSkill(storedSkills, expectedSkill);
    if (!existingSkill) {
      createStoredWorkspaceSkillSync(expectedSkill, workspaceId);
      storedSkills = [...storedSkills, expectedSkill];
      changed = true;
      continue;
    }

    if (syncPredefinedAgentTemplateSkill(existingSkill, expectedSkill, workspaceId)) {
      changed = true;
    }
  }

  if (changed) {
    storedSkills = listStoredWorkspaceSkillsSync(workspaceId);
  }
  ensurePredefinedAgentTemplateSkillsInStateSnapshotSync(storedSkills, workspaceId);
  return storedSkills;
}

export function createWorkspaceSkillSync(input: {
  name: string;
  description?: string;
  content?: string;
  sourceType?: string;
  sourceUrl?: string;
  configJson?: string;
}, workspaceId?: string): WorkspaceSkill {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Skill name is required.");
  }
  if (listWorkspaceSkillsSync(workspaceId).some((skill) => sameValue(skill.name, name))) {
    throw new Error(`Skill "${name}" already exists.`);
  }
  const state = ensureWorkspaceStateSync(workspaceId);

  const skill = createWorkspaceSkillRecord({
    name,
    description: input.description?.trim() ?? "",
    content: input.content,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    configJson: input.configJson,
  });
  const storedSkill = createStoredWorkspaceSkillSync(skill, workspaceId);

  state.skills.unshift(storedSkill);
  state.ledger.unshift({
    title: "Skill created",
    note: `${name} was added to the workspace skill library.`,
  });

  writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
  return storedSkill;
}

export function updateWorkspaceSkillSync(input: {
  skillId: string;
  name?: string;
  description?: string;
  sourceType?: string;
  sourceUrl?: string;
  configJson?: string;
}, workspaceId?: string): WorkspaceSkill {
  const skill = requireStoredSkill(input.skillId, workspaceId);
  if (isBuiltinSkill(skill.name)) {
    throw new Error(`${skill.name} 是系统预定义 skill，不能编辑。`);
  }

  const nextName = typeof input.name === "string" ? input.name.trim() : skill.name;
  if (!nextName) {
    throw new Error("Skill name is required.");
  }
  if (listWorkspaceSkillsSync(workspaceId).some((item) => item.id !== skill.id && sameValue(item.name, nextName))) {
    throw new Error(`Skill "${nextName}" already exists.`);
  }
  const state = ensureWorkspaceStateSync(workspaceId);

  const updatedAt = new Date().toISOString();
  const nextDescription = typeof input.description === "string" ? input.description.trim() : skill.description;
  const storedSkill = updateStoredWorkspaceSkillMetaSync({
    skillId: skill.id,
    name: nextName,
    description: nextDescription,
    sourceType: input.sourceType ?? skill.sourceType,
    sourceUrl: input.sourceUrl ?? skill.sourceUrl,
    configJson: input.configJson ?? skill.configJson,
    updatedAt,
  }, workspaceId);
  if (!storedSkill) {
    throw new Error(`Skill "${input.skillId}" does not exist.`);
  }

  skill.name = storedSkill.name;
  skill.description = storedSkill.description;
  skill.sourceType = storedSkill.sourceType;
  skill.sourceUrl = storedSkill.sourceUrl;
  skill.configJson = storedSkill.configJson;
  skill.updatedAt = storedSkill.updatedAt;
  skill.files = ensureRequiredSkillFile(storedSkill).files;

  state.ledger.unshift({
    title: "Skill updated",
    note: `${skill.name} metadata was updated.`,
  });

  replaceStateSkillSnapshot(state, skill.id, skill);
  writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
  return skill;
}

export function readWorkspaceSkillSync(skillId: string, workspaceId?: string): WorkspaceSkill | null {
  return readStoredWorkspaceSkillSync(skillId, workspaceId);
}

export function deleteWorkspaceSkillSync(skillId: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const skill = requireStoredSkill(skillId, workspaceId);
  if (isBuiltinSkill(skill.name)) {
    throw new Error(`${skill.name} 是系统预定义 skill，不能删除。`);
  }

  const removed = deleteStoredWorkspaceSkillSync(skillId, workspaceId);
  if (!removed) {
    throw new Error(`Skill "${skillId}" does not exist.`);
  }

  removeStateSkillSnapshot(state, skillId);
  state.activeEmployees = state.activeEmployees.map((employee) => ({
    ...employee,
    skillIds: employee.skillIds.filter((id) => id !== skillId),
  }));
  state.ledger.unshift({
    title: "Skill deleted",
    note: `${skill.name} was removed from the workspace skill library and all agent assignments were cleared.`,
  });

  return writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
}

export function upsertWorkspaceSkillFileSync(input: {
  skillId: string;
  fileId?: string;
  path: string;
  content: string;
}, workspaceId?: string): WorkspaceSkillFile {
  const state = ensureWorkspaceStateSync(workspaceId);
  const skill = requireStoredSkill(input.skillId, workspaceId);
  if (isBuiltinSkill(skill.name)) {
    throw new Error(`${skill.name} 是系统预定义 skill，不能编辑文件。`);
  }

  const path = normalizeSkillFilePath(input.path);
  if (!path) {
    throw new Error("File path is required.");
  }

  const now = new Date().toISOString();
  const existingById = input.fileId ? skill.files.find((file) => file.id === input.fileId) : undefined;
  const existingByPath = skill.files.find((file) => sameValue(file.path, path));

  if (existingById) {
    if (existingByPath && existingByPath.id !== existingById.id) {
      throw new Error(`File "${path}" already exists in this skill.`);
    }
    const storedSkill = upsertStoredWorkspaceSkillFileSync({
      skillId: skill.id,
      file: {
        id: existingById.id,
        path,
        content: input.content,
        createdAt: existingById.createdAt,
        updatedAt: now,
      },
      skillUpdatedAt: now,
    }, workspaceId);
    if (!storedSkill) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }
    const storedFile = storedSkill.files.find((file) => file.id === existingById.id);
    if (!storedFile) {
      throw new Error(`Skill file "${existingById.id}" does not exist.`);
    }
    existingById.path = storedFile.path;
    existingById.content = storedFile.content;
    existingById.updatedAt = storedFile.updatedAt;
    skill.updatedAt = storedSkill.updatedAt;
    state.ledger.unshift({
      title: "Skill file updated",
      note: `${skill.name} file ${path} was updated.`,
    });
    replaceStateSkillSnapshot(state, skill.id, skill);
    writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
    return existingById;
  }

  if (existingByPath) {
    const storedSkill = upsertStoredWorkspaceSkillFileSync({
      skillId: skill.id,
      file: {
        id: existingByPath.id,
        path,
        content: input.content,
        createdAt: existingByPath.createdAt,
        updatedAt: now,
      },
      skillUpdatedAt: now,
    }, workspaceId);
    if (!storedSkill) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }
    const storedFile = storedSkill.files.find((file) => file.id === existingByPath.id);
    if (!storedFile) {
      throw new Error(`File "${path}" already exists in this skill.`);
    }
    existingByPath.content = storedFile.content;
    existingByPath.updatedAt = storedFile.updatedAt;
    skill.updatedAt = storedSkill.updatedAt;
    state.ledger.unshift({
      title: "Skill file updated",
      note: `${skill.name} file ${path} was updated.`,
    });
    replaceStateSkillSnapshot(state, skill.id, skill);
    writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
    return existingByPath;
  }

  const file: WorkspaceSkillFile = {
    id: `skill-file-${createOpaqueId()}`,
    path,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  };
  const storedSkill = upsertStoredWorkspaceSkillFileSync({
    skillId: skill.id,
    file,
    skillUpdatedAt: now,
  }, workspaceId);
  if (!storedSkill) {
    throw new Error(`Skill "${input.skillId}" does not exist.`);
  }
  skill.files = normalizeWorkspaceSkillFiles(storedSkill.files, storedSkill.name, storedSkill.description);
  skill.updatedAt = storedSkill.updatedAt;
  state.ledger.unshift({
    title: "Skill file created",
    note: `${skill.name} added file ${path}.`,
  });

  replaceStateSkillSnapshot(state, skill.id, skill);
  writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
  return skill.files.find((item) => item.id === file.id) ?? file;
}

export function deleteWorkspaceSkillFileSync(skillId: string, fileId: string, workspaceId?: string): DofeAgentState {
  const state = ensureWorkspaceStateSync(workspaceId);
  const skill = requireStoredSkill(skillId, workspaceId);
  if (isBuiltinSkill(skill.name)) {
    throw new Error(`${skill.name} 是系统预定义 skill，不能删除文件。`);
  }

  const file = skill.files.find((item) => item.id === fileId);
  if (!file) {
    throw new Error(`Skill file "${fileId}" does not exist.`);
  }
  if (sameValue(file.path, "SKILL.md")) {
    throw new Error("SKILL.md is required and cannot be deleted.");
  }

  const updatedAt = new Date().toISOString();
  const storedSkill = deleteStoredWorkspaceSkillFileSync(skillId, fileId, updatedAt, workspaceId);
  if (!storedSkill) {
    throw new Error(`Skill "${skillId}" does not exist.`);
  }
  skill.files = normalizeWorkspaceSkillFiles(storedSkill.files, storedSkill.name, storedSkill.description);
  skill.updatedAt = storedSkill.updatedAt;
  state.ledger.unshift({
    title: "Skill file deleted",
    note: `${skill.name} file ${file.path} was deleted.`,
  });

  replaceStateSkillSnapshot(state, skill.id, skill);
  return writeWorkspaceStateRecordSync(normalizeWorkspaceState(state), workspaceId);
}

function requireStoredSkill(skillId: string, workspaceId?: string): WorkspaceSkill {
  const skill = readStoredWorkspaceSkillSync(skillId, workspaceId);
  if (!skill) {
    throw new Error(`Skill "${skillId}" does not exist.`);
  }
  return skill;
}

export function isBuiltinSkill(name: string): boolean {
  return isSystemSkillName(name);
}

function findPredefinedAgentTemplateSkill(
  storedSkills: WorkspaceSkill[],
  expectedSkill: WorkspaceSkill,
): WorkspaceSkill | undefined {
  return storedSkills.find((skill) => sameValue(skill.name, expectedSkill.name)) ?? storedSkills.find((skill) => (
    skill.sourceType === expectedSkill.sourceType
    && typeof skill.sourceUrl === "string"
    && skill.sourceUrl === expectedSkill.sourceUrl
  ));
}

function findCanonicalStoredSkill(
  storedSkills: WorkspaceSkill[],
  snapshotSkill: WorkspaceSkill,
): WorkspaceSkill | undefined {
  return storedSkills.find((skill) => skill.id === snapshotSkill.id)
    ?? storedSkills.find((skill) => sameValue(skill.name, snapshotSkill.name))
    ?? storedSkills.find((skill) => (
      Boolean(skill.sourceType)
      && Boolean(skill.sourceUrl)
      && skill.sourceType === snapshotSkill.sourceType
      && skill.sourceUrl === snapshotSkill.sourceUrl
    ));
}

function sameSkillSnapshotSet(left: WorkspaceSkill[], right: WorkspaceSkill[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftSkill) => {
    const rightSkill = findCanonicalStoredSkill(right, leftSkill);
    return rightSkill ? predefinedSkillSnapshotsMatch(leftSkill, rightSkill) : false;
  });
}

function syncPredefinedAgentTemplateSkill(
  existingSkill: WorkspaceSkill,
  expectedSkill: WorkspaceSkill,
  workspaceId?: string,
): boolean {
  let changed = false;
  const updatedAt = new Date().toISOString();

  if (
    existingSkill.name !== expectedSkill.name
    || existingSkill.description !== expectedSkill.description
    || existingSkill.sourceType !== expectedSkill.sourceType
    || existingSkill.sourceUrl !== expectedSkill.sourceUrl
    || (existingSkill.configJson ?? "{}") !== (expectedSkill.configJson ?? "{}")
  ) {
    updateStoredWorkspaceSkillMetaSync({
      skillId: existingSkill.id,
      name: expectedSkill.name,
      description: expectedSkill.description,
      sourceType: expectedSkill.sourceType,
      sourceUrl: expectedSkill.sourceUrl,
      configJson: expectedSkill.configJson,
      updatedAt,
    }, workspaceId);
    changed = true;
  }

  const expectedPaths = new Set(expectedSkill.files.map((file) => file.path.toLocaleLowerCase("en-US")));
  for (const expectedFile of expectedSkill.files) {
    const existingFile = existingSkill.files.find((file) => sameValue(file.path, expectedFile.path));
    if (existingFile && existingFile.content === expectedFile.content) {
      continue;
    }

    upsertStoredWorkspaceSkillFileSync({
      skillId: existingSkill.id,
      file: {
        id: existingFile?.id ?? expectedFile.id ?? `skill-file-${createOpaqueId()}`,
        path: expectedFile.path,
        content: expectedFile.content,
        createdAt: existingFile?.createdAt ?? expectedFile.createdAt ?? updatedAt,
        updatedAt,
      },
      skillUpdatedAt: updatedAt,
    }, workspaceId);
    changed = true;
  }

  for (const existingFile of existingSkill.files) {
    if (expectedPaths.has(existingFile.path.toLocaleLowerCase("en-US"))) {
      continue;
    }

    deleteStoredWorkspaceSkillFileSync(existingSkill.id, existingFile.id, updatedAt, workspaceId);
    changed = true;
  }

  return changed;
}

function ensurePredefinedAgentTemplateSkillsInStateSnapshotSync(
  storedSkills: WorkspaceSkill[],
  workspaceId?: string,
): void {
  const predefinedSkills = storedSkills.filter((skill) => isPredefinedAgentTemplateSkillName(skill.name));
  if (predefinedSkills.length === 0) {
    return;
  }

  const state = readWorkspaceStateRecordSync(workspaceId);
  if (!state) {
    return;
  }

  const stateSkills = Array.isArray(state.skills) ? state.skills : [];
  const stateHasCurrentPredefinedSkills = predefinedSkills.every((storedSkill) =>
    stateSkills.some((stateSkill) => predefinedSkillSnapshotsMatch(stateSkill, storedSkill)),
  );
  if (stateHasCurrentPredefinedSkills) {
    return;
  }

  const predefinedSkillNames = new Set(predefinedSkills.map((skill) => skill.name.toLocaleLowerCase("en-US")));
  writeWorkspaceStateRecordSync({
    ...state,
    skills: [
      ...stateSkills.filter((skill) => !predefinedSkillNames.has(skill.name.toLocaleLowerCase("en-US"))),
      ...predefinedSkills,
    ],
  }, workspaceId, { skipVersionCheck: true });
}

function predefinedSkillSnapshotsMatch(left: WorkspaceSkill, right: WorkspaceSkill): boolean {
  return (
    left.id === right.id
    && sameValue(left.name, right.name)
    && left.description === right.description
    && left.sourceType === right.sourceType
    && left.sourceUrl === right.sourceUrl
    && (left.configJson ?? "{}") === (right.configJson ?? "{}")
    && readSkillMarkdownContent(left) === readSkillMarkdownContent(right)
  );
}

function readSkillMarkdownContent(skill: WorkspaceSkill): string {
  return skill.files.find((file) => sameValue(file.path, "SKILL.md"))?.content ?? "";
}

function replaceStateSkillSnapshot(state: DofeAgentState, skillId: string, nextSkill: WorkspaceSkill): void {
  const nextSkills = state.skills.filter((item) => item.id !== skillId);
  nextSkills.unshift(nextSkill);
  state.skills = nextSkills;
}

function removeStateSkillSnapshot(state: DofeAgentState, skillId: string): void {
  state.skills = state.skills.filter((item) => item.id !== skillId);
}
