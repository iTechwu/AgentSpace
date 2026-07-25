import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  createUserSync,
  createWorkspaceMembershipSync,
  enqueueNativeTaskSync,
  loadRepositoryEnvIntoProcess,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  createEmployeeSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "@dofe-agent/services";
import {
  appendKnowledgeProposalManifestEntry,
  MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES,
} from "./runtime-output-manifests.ts";
import { applyKnowledgeProposalOperations } from "./knowledge-proposals.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-knowledge-proposals-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = repositoryRoot;
  loadRepositoryEnvIntoProcess({ startDir: repositoryRoot, override: false });
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

test("daemon applies CLI generated knowledge proposal manifests as pending approvals", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-knowledge-proposal-work-"));
  try {
    const { queued, workspaceId } = seedWorkspace("apply");
    mkdirSync(join(workDir, "runtime-output", "artifacts", "knowledge"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "knowledge", "approval.md"), "# Approval\n", "utf8");
    appendKnowledgeProposalManifestEntry(workDir, {
      operation: "create",
      title: "Approval checklist",
      contentPath: "runtime-output/artifacts/knowledge/approval.md",
      assignmentMode: "selected_agents",
    });

    const result = applyKnowledgeProposalOperations({
      workDir,
      workspaceId,
      actorName: "Atlas",
      sourceTaskQueueId: queued.id,
      sourceChannelName: "general",
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.knowledgeProposals[0]?.status, "pending");
    assert.equal(readWorkspaceStateSync(workspaceId).approvals[0]?.type, "knowledge_proposal");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("daemon rejects hand-written knowledge proposal manifests", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-knowledge-proposal-work-"));
  try {
    const { queued, workspaceId } = seedWorkspace("reject-forged");
    mkdirSync(join(workDir, "runtime-output"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "knowledge-proposals.json"),
      JSON.stringify({
        version: 1,
        proposals: [{
          operation: "create",
          title: "Forged",
          contentPath: "runtime-output/artifacts/knowledge/forged.md",
        }],
      }),
      "utf8",
    );

    const result = applyKnowledgeProposalOperations({
      workDir,
      workspaceId,
      actorName: "Atlas",
      sourceTaskQueueId: queued.id,
      sourceChannelName: "general",
    });

    assert.equal(result.knowledgeProposals.length, 0);
    assert.ok(result.warnings[0]?.includes("knowledge-proposals.json 已被拒绝"));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("daemon rejects knowledge proposal markdown with token material", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-knowledge-proposal-work-"));
  try {
    const { queued, workspaceId } = seedWorkspace("reject-secret");
    mkdirSync(join(workDir, "runtime-output", "artifacts", "knowledge"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "artifacts", "knowledge", "secret.md"),
      "Bearer ya29.secret-token-material-1234567890",
      "utf8",
    );
    appendKnowledgeProposalManifestEntry(workDir, {
      operation: "create",
      title: "Secret checklist",
      contentPath: "runtime-output/artifacts/knowledge/secret.md",
    });

    const result = applyKnowledgeProposalOperations({
      workDir,
      workspaceId,
      actorName: "Atlas",
      sourceTaskQueueId: queued.id,
      sourceChannelName: "general",
    });

    assert.equal(result.knowledgeProposals[0]?.status, "failed");
    assert.match(result.warnings[0] ?? "", /credential|token/i);
    assert.equal(readWorkspaceStateSync(workspaceId).approvals.length, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("daemon rejects invalid knowledge proposal content paths", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-knowledge-proposal-work-"));
  try {
    const { queued, workspaceId } = seedWorkspace("reject-content-paths");
    mkdirSync(join(workDir, "runtime-output", "artifacts", "knowledge"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "knowledge", "notes.txt"), "not markdown", "utf8");
    writeFileSync(
      join(workDir, "runtime-output", "artifacts", "knowledge", "large.md"),
      "x".repeat(MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES + 1),
      "utf8",
    );
    for (const [title, contentPath] of [
      ["Escaping path", "../escape.md"],
      ["Missing file", "runtime-output/artifacts/knowledge/missing.md"],
      ["Text file", "runtime-output/artifacts/knowledge/notes.txt"],
      ["Large file", "runtime-output/artifacts/knowledge/large.md"],
    ] as const) {
      appendKnowledgeProposalManifestEntry(workDir, {
        operation: "create",
        title,
        contentPath,
      });
    }

    const result = applyKnowledgeProposalOperations({
      workDir,
      workspaceId,
      actorName: "Atlas",
      sourceTaskQueueId: queued.id,
      sourceChannelName: "general",
    });

    assert.deepEqual(result.knowledgeProposals.map((proposal) => proposal.status), [
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    assert.ok(result.warnings.some((warning) => warning.includes("relative path inside runtime-output")));
    assert.ok(result.warnings.some((warning) => warning.includes("ENOENT")));
    assert.ok(result.warnings.some((warning) => warning.includes("Markdown .md")));
    assert.ok(result.warnings.some((warning) => warning.includes("256 KB")));
    assert.equal(readWorkspaceStateSync(workspaceId).approvals.length, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test.after(() => {
  process.chdir(originalCwd);
});

function seedWorkspace(label: string) {
  const workspaceId = `daemon-knowledge-proposals-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Daemon knowledge proposals ${label}`,
    createdBy: "test",
  });
  resetWorkspaceStateSync(workspaceId);
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(workspaceId),
    channels: [
      {
        name: "general",
        kind: "group",
        humanMemberNames: ["Owner"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
    ],
  }, workspaceId);
  const owner = createUserSync({
    displayName: "Owner",
    primaryEmail: `owner-${Math.random().toString(36).slice(2)}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: owner.id, role: "owner" });
  createEmployeeSync({ name: "Atlas", role: "Planner" }, workspaceId);
  const snapshot = registerDaemonRuntimesSync({
    workspaceId,
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Codex", version: "test" }],
  });
  bindEmployeeRuntimeSync({ workspaceId, employeeName: "Atlas", runtimeId: snapshot.runtimes[0]!.id });
  const queued = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Draft checklist",
    channel: "general",
    priority: "medium",
  });
  assert.ok(queued);
  return { owner, queued, workspaceId };
}
