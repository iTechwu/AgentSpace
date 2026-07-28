import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discardTaskOutputAttachments, loadTaskOutputEnvelope } from "dofe-agent-daemon";
import {
  FEISHU_RUNTIME_DATA_OPERATION_REQUESTS_KIND,
  FEISHU_RUNTIME_DATA_OPERATION_REQUESTS_RELATIVE_PATH,
} from "@dofe-agent/services";
import { runOutputCommand } from "./output.ts";

test("output attach creates and appends agent-output attachments", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "chart.png"), "image", "utf8");
    writeFileSync(join(workDir, "runtime-output", "artifacts", "report.md"), "# Report\n", "utf8");

    assert.equal(
      await runOutputCommand(
        "attach",
        [
          "runtime-output/artifacts/chart.png",
          "--name",
          "chart.png",
          "--media-type",
          "image/png",
          "--text",
          "图表已生成。",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );
    assert.equal(
      await runOutputCommand(
        "attach",
        ["runtime-output/artifacts/report.md", "--name", "report.md", "--work-dir", workDir],
        "text",
      ),
      0,
    );

    const manifest = JSON.parse(readFileSync(join(workDir, "runtime-output", "agent-output.json"), "utf8")) as {
      text?: string;
      attachments?: Array<{ path: string; name?: string; mediaType?: string }>;
    };
    assert.equal(manifest.text, "图表已生成。");
    assert.equal(manifest.attachments?.length, 2);
    assert.equal(manifest.attachments?.[0]?.mediaType, "image/png");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("daemon consumes CLI-generated agent-output manifests", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "chart.png"), "image", "utf8");
    assert.equal(
      await runOutputCommand(
        "attach",
        [
          "runtime-output/artifacts/chart.png",
          "--name",
          "chart.png",
          "--media-type",
          "image/png",
          "--text",
          "图表已生成。",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );

    const output = loadTaskOutputEnvelope(workDir, "fallback", "default");
    assert.equal(output.text, "图表已生成。");
    assert.equal(output.warnings.length, 0);
    assert.equal(output.attachments[0]?.fileName, "chart.png");
    discardTaskOutputAttachments(output.attachments);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("output attach rejects absolute files unless --copy is set", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  const externalDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-external-"));
  try {
    const externalFile = join(externalDir, "chart.png");
    writeFileSync(externalFile, "image", "utf8");

    assert.equal(
      await runOutputCommand("attach", [externalFile, "--work-dir", workDir], "text"),
      1,
    );
    assert.equal(
      await runOutputCommand("attach", [externalFile, "--copy", "--work-dir", workDir], "text"),
      0,
    );
    assert.equal(existsSync(join(workDir, "runtime-output", "artifacts", "chart.png")), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("output document command writes a compatible manifest", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "notes.md"), "# Notes\n", "utf8");

    assert.equal(
      await runOutputCommand(
        "document",
        [
          "upsert",
          "--title",
          "Research Notes",
          "--content",
          "runtime-output/artifacts/notes.md",
          "--summary",
          "Notes",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );
    assert.equal(await runOutputCommand("validate", ["--work-dir", workDir], "text"), 0);

    const documents = JSON.parse(readFileSync(join(workDir, "runtime-output", "channel-documents.json"), "utf8")) as {
      documents?: Array<{ title: string; contentPath: string }>;
    };
    assert.equal(documents.documents?.[0]?.contentPath, "runtime-output/artifacts/notes.md");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("output knowledge commands write controlled proposal manifests", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    mkdirSync(join(workDir, "runtime-output", "artifacts", "knowledge"), { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "artifacts", "knowledge", "approval.md"), "# Approval\n", "utf8");

    assert.equal(
      await runOutputCommand(
        "knowledge",
        [
          "propose-create",
          "--title",
          "Approval checklist",
          "--content-file",
          "runtime-output/artifacts/knowledge/approval.md",
          "--assignment-mode",
          "selected_agents",
          "--reason",
          "Reusable workflow",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );

    const manifest = JSON.parse(readFileSync(join(workDir, "runtime-output", "knowledge-proposals.json"), "utf8")) as {
      generatedBy?: string;
      proposals?: Array<{ operation: string; title: string; contentPath: string; reason?: string; assignToSelf?: boolean }>;
    };
    assert.equal(manifest.generatedBy, "dofe-agent-cli");
    assert.equal(manifest.proposals?.[0]?.operation, "create");
    assert.equal(manifest.proposals?.[0]?.title, "Approval checklist");
    assert.equal(manifest.proposals?.[0]?.contentPath, "runtime-output/artifacts/knowledge/approval.md");
    assert.equal(manifest.proposals?.[0]?.assignToSelf, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("output permission command writes a controlled manifest", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    assert.equal(
      await runOutputCommand(
        "permission",
        [
          "request-document",
          "--role",
          "forwarder",
          "--reason",
          "Need to share it with general.",
          "--document-id",
          "channel-doc-123",
          "--target-channel",
          "general",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );
    assert.equal(await runOutputCommand("validate", ["--work-dir", workDir], "text"), 0);

    const permissionRequests = JSON.parse(readFileSync(join(workDir, "runtime-output", "permission-requests.json"), "utf8")) as {
      generatedBy?: string;
      requests?: Array<{ requestedRole?: string; documentId?: string }>;
    };
    assert.equal(permissionRequests.generatedBy, "dofe-agent-cli");
    assert.equal(permissionRequests.requests?.[0]?.requestedRole, "forwarder");
    assert.equal(permissionRequests.requests?.[0]?.documentId, "channel-doc-123");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("output feishu data-operation-approval writes controlled approval request manifest", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  try {
    assert.equal(
      await runOutputCommand(
        "feishu",
        [
          "data-operation-approval",
          "--operation",
          "sheets.update_range",
          "--type",
          "sheet",
          "--resource",
          "shtcnABC123",
          "--range",
          "Sheet1!A1:B1",
          "--values-json",
          "[[\"DofeAgent smoke\"]]",
          "--preview",
          "Update smoke range",
          "--work-dir",
          workDir,
        ],
        "text",
      ),
      0,
    );
    assert.equal(await runOutputCommand("validate", ["--work-dir", workDir], "text"), 0);

    const manifest = JSON.parse(
      readFileSync(join(workDir, FEISHU_RUNTIME_DATA_OPERATION_REQUESTS_RELATIVE_PATH), "utf8"),
    ) as {
      kind?: string;
      generatedBy?: string;
      requests?: Array<{
        operationType?: string;
        providerResourceType?: string;
        providerResourceToken?: string;
        parameters?: Record<string, unknown>;
        contentPreview?: string;
      }>;
    };
    assert.equal(manifest.kind, FEISHU_RUNTIME_DATA_OPERATION_REQUESTS_KIND);
    assert.equal(manifest.generatedBy, "dofe-agent-cli");
    assert.equal(manifest.requests?.[0]?.operationType, "sheets.update_range");
    assert.equal(manifest.requests?.[0]?.providerResourceType, "sheet");
    assert.equal(manifest.requests?.[0]?.providerResourceToken, "shtcnABC123");
    assert.deepEqual(manifest.requests?.[0]?.parameters, {
      range: "Sheet1!A1:B1",
      values: [["DofeAgent smoke"]],
    });
    assert.equal(manifest.requests?.[0]?.contentPreview, "Update smoke range");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});


test("output skill import packages local skills into runtime-output artifacts", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-output-command-"));
  const skillDir = mkdtempSync(join(tmpdir(), "dofe-agent-local-skill-"));
  try {
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: local-skill\n---\n# Local\n", "utf8");
    assert.equal(
      await runOutputCommand(
        "skill",
        ["import", "--local-path", skillDir, "--conflict", "rename", "--work-dir", workDir],
        "text",
      ),
      0,
    );

    const manifest = JSON.parse(readFileSync(join(workDir, "runtime-output", "skill-imports.json"), "utf8")) as {
      imports?: Array<{ path?: string; conflict?: string }>;
    };
    assert.match(manifest.imports?.[0]?.path ?? "", /^runtime-output\/artifacts\/skills\/dofe-agent-local-skill-/);
    assert.equal(manifest.imports?.[0]?.conflict, "rename");
    assert.equal(await runOutputCommand("validate", ["--work-dir", workDir], "text"), 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  }
});
