import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  listStoredAgentSkillAssignmentsSync,
  listStoredWorkspaceSkillsSync,
  replaceStoredWorkspaceSkillsSync,
  readWorkspaceStateRecordSync,
  writeWorkspaceStateRecordSync,
} from "@dofe-agent/db";
import {
  BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME,
  createEmployeeSync,
  createWorkspaceSkillSync,
  deleteEmployeeSync,
  deleteWorkspaceSkillFileSync,
  deleteWorkspaceSkillSync,
  listWorkspaceSkillsSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  resolveSystemAgentTemplateForWorkspaceSync,
  setEmployeeSkillIdsSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-skills-storage-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

test("skills and assignments are mirrored into the dedicated store", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  upsertWorkspaceSkillFileSync({
    skillId: skill.id,
    path: "notes.md",
    content: "Use this for structured research notes.",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);

  const storedSkills = listStoredWorkspaceSkillsSync();
  const storedAssignments = listStoredAgentSkillAssignmentsSync();

  const mirroredSkill = storedSkills.find((item) => item.id === skill.id);
  assert.ok(mirroredSkill);
  assert.equal(mirroredSkill?.files.some((file) => file.path === "notes.md"), true);
  assert.ok(
    storedAssignments.some((assignment) => assignment.employeeName === "Planner" && assignment.skillId === skill.id),
  );
  assert.ok(
    storedAssignments.some((assignment) => assignment.agentId === "agent:Planner" && assignment.skillId === skill.id),
  );
});

test("state_json skill drift is not repaired from the dedicated store on read", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);

  writeWorkspaceStateRecordSync({
    ...persisted!,
    skills: [],
    activeEmployees: persisted!.activeEmployees.map((employee) =>
      employee.name === "Planner"
        ? {
            ...employee,
            skillIds: [],
          }
        : employee,
    ),
  });

  const snapshot = readWorkspaceStateSync();
  assert.equal(snapshot.skills.some((item) => item.id === skill.id), false);
  assert.deepEqual(
    snapshot.activeEmployees.find((employee) => employee.name === "Planner")?.skillIds,
    [],
  );
});

test("skill updates and file deletions stay mirrored in the dedicated store", () => {
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  const extraFile = upsertWorkspaceSkillFileSync({
    skillId: skill.id,
    path: "notes.md",
    content: "Use this for structured research notes.",
  });

  updateWorkspaceSkillSync({
    skillId: skill.id,
    name: "research-pack-v2",
    description: "Research helper v2",
  });
  deleteWorkspaceSkillFileSync(skill.id, extraFile.id);

  const mirrored = listStoredWorkspaceSkillsSync().find((item) => item.id === skill.id);
  assert.ok(mirrored);
  assert.equal(mirrored?.name, "research-pack-v2");
  assert.equal(mirrored?.description, "Research helper v2");
  assert.equal(mirrored?.files.some((file) => file.id === extraFile.id), false);
});

test("skill deletion clears dedicated assignments and snapshot state", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);
  deleteWorkspaceSkillSync(skill.id);

  assert.equal(listStoredWorkspaceSkillsSync().some((item) => item.id === skill.id), false);
  assert.equal(
    listStoredAgentSkillAssignmentsSync().some((assignment) => assignment.skillId === skill.id),
    false,
  );

  const snapshot = readWorkspaceStateSync();
  assert.equal(snapshot.skills.some((item) => item.id === skill.id), false);
  assert.deepEqual(
    snapshot.activeEmployees.find((employee) => employee.name === "Planner")?.skillIds ?? [],
    [],
  );
});

test("writing workspace state does not override dedicated skill storage once initialized", () => {
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);

  writeWorkspaceStateSync({
    ...persisted!,
    skills: [],
  });

  const storedSkills = listStoredWorkspaceSkillsSync();
  assert.ok(storedSkills.some((item) => item.id === skill.id));

  const snapshot = readWorkspaceStateSync();
  assert.equal(snapshot.skills.some((item) => item.id === skill.id), false);
});

test("outdated builtin skill content is replaced with the canonical version", () => {
  const storedSkills = listStoredWorkspaceSkillsSync();
  const outdatedSkills = storedSkills.map((skill) => {
    if (skill.name !== "return-output-files") {
      return skill;
    }
    return {
      ...skill,
      description: "Old output contract",
      files: skill.files.map((file) =>
        file.path === "SKILL.md"
          ? {
              ...file,
              content: file.content
                .replace(/runtime-output\/agent-output\.json/g, "agent-output.json")
                .replace(/runtime-output\/artifacts\//g, "artifacts/"),
            }
          : file,
      ),
    };
  });
  replaceStoredWorkspaceSkillsSync(outdatedSkills);

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);
  writeWorkspaceStateRecordSync({
    ...persisted!,
    skills: outdatedSkills,
  });

  const snapshot = readWorkspaceStateSync();
  const builtinSkill = snapshot.skills.find((skill) => skill.name === "return-output-files");
  assert.ok(builtinSkill);
  const builtinContent = builtinSkill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  assert.match(builtinContent, /dofe-agent output attach runtime-output\/artifacts\/chart\.png/);
  assert.match(builtinContent, /runtime-output\/artifacts\/summary\.md/);
  assert.doesNotMatch(builtinContent, /write `agent-output\.json` in the root of the current `workDir`/);

  const storedSkill = listStoredWorkspaceSkillsSync().find((skill) => skill.name === "return-output-files");
  const storedContent = storedSkill?.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  assert.doesNotMatch(storedContent, /runtime-output\/agent-output\.json/);
});

test("employee create and delete keep dedicated agent_skill storage in sync", () => {
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });

  createEmployeeSync({
    name: "Planner",
    skillIds: [skill.id],
  });
  assert.ok(
    listStoredAgentSkillAssignmentsSync().some(
      (assignment) => assignment.employeeName === "Planner" && assignment.skillId === skill.id,
    ),
  );

  deleteEmployeeSync("Planner");
  assert.equal(
    listStoredAgentSkillAssignmentsSync().some((assignment) => assignment.employeeName === "Planner"),
    false,
  );
});

test("writing workspace state does not override dedicated agent_skill assignments once initialized", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);

  const persisted = readWorkspaceStateRecordSync();
  assert.ok(persisted);

  writeWorkspaceStateSync({
    ...persisted!,
    activeEmployees: persisted!.activeEmployees.map((employee) =>
      employee.name === "Planner"
        ? {
            ...employee,
            skillIds: [],
          }
        : employee,
    ),
  });

  assert.ok(
    listStoredAgentSkillAssignmentsSync().some(
      (assignment) => assignment.employeeName === "Planner" && assignment.skillId === skill.id,
    ),
  );

  const snapshot = readWorkspaceStateSync();
  assert.deepEqual(
    snapshot.activeEmployees.find((employee) => employee.name === "Planner")?.skillIds,
    [],
  );
});

test("resetWorkspaceStateSync clears dedicated skill storage", () => {
  createEmployeeSync({ name: "Planner" });
  const skill = createWorkspaceSkillSync({
    name: "research-pack",
    description: "Research helper",
  });
  setEmployeeSkillIdsSync("Planner", [skill.id]);

  resetWorkspaceStateSync();

  const storedSkills = listStoredWorkspaceSkillsSync();
  const storedAssignments = listStoredAgentSkillAssignmentsSync();
  assert.equal(storedAssignments.length, 0);
  assert.ok(storedSkills.some((item) => item.name === "workspace-context"));
  assert.ok(storedSkills.some((item) => item.name === "return-output-files"));
  assert.ok(storedSkills.some((item) => item.name === BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME));
  assert.equal(storedSkills.some((item) => item.id === skill.id), false);
});

test("agent template skills are preloaded into skill storage and state", () => {
  const skills = listWorkspaceSkillsSync();
  const financeSkill = skills.find((item) => item.name === "financial-analysis-agent");
  assert.ok(financeSkill);
  assert.equal(financeSkill.sourceType, "skills.sh");
  assert.equal(financeSkill.sourceUrl, "https://skills.sh/qodex-ai/ai-agent-skills/financial-analysis-agent");
  assert.equal(financeSkill.description.startsWith("Create agents for financial analysis"), true);
  assert.equal(financeSkill.files.some((file) => file.path === "examples/financial_data_collector.py"), true);
  assert.equal(
    financeSkill.files.find((file) => file.path === "SKILL.md")?.content.includes("preloaded by DofeAgent"),
    false,
  );

  const snapshot = readWorkspaceStateSync();
  assert.ok(snapshot.skills.some((item) => item.id === financeSkill.id));
});

test("agent template resolution binds preloaded skills automatically", () => {
  const resolved = resolveSystemAgentTemplateForWorkspaceSync("finance-analyst");
  const financeSkill = listWorkspaceSkillsSync().find((item) => item.name === "financial-analysis-agent");

  assert.ok(financeSkill);
  assert.deepEqual(resolved.skillIds, [financeSkill.id]);
});

test("builtin skills cannot be edited or have files modified", () => {
  const builtin = listStoredWorkspaceSkillsSync().find((item) => item.name === BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME);
  assert.ok(builtin);

  assert.throws(
    () =>
      updateWorkspaceSkillSync({
        skillId: builtin!.id,
        description: "mutated",
      }),
    /系统预定义 skill，不能编辑/,
  );

  assert.throws(
    () =>
      upsertWorkspaceSkillFileSync({
        skillId: builtin!.id,
        fileId: builtin!.files[0]?.id,
        path: "SKILL.md",
        content: "mutated",
      }),
    /系统预定义 skill，不能编辑文件/,
  );
});

test.after(() => {
  process.chdir(originalCwd);
});
