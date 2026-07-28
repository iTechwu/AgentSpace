import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectRuntimeOutputBundle, materializeInputBundle } from "./bundle.ts";

test("materializeInputBundle rejects path traversal", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));

  try {
    assert.throws(
      () =>
        materializeInputBundle(workDir, {
          version: 1,
          format: "json-inline-v1",
          taskId: "task-1",
          runtimeId: "runtime-1",
          prompt: "hi",
          metadata: {
            taskTriggerType: "channel_chat",
          },
          files: [
            {
              path: "../escape.txt",
              contentBase64: Buffer.from("bad").toString("base64"),
            },
          ],
        }),
      /escapes workDir/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("collectRuntimeOutputBundle captures manifests and referenced runtime-output files", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));

  try {
    const artifactsDir = join(workDir, "runtime-output", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "agent-output.json"),
      JSON.stringify({
        text: "done",
        attachments: [{ path: "runtime-output/artifacts/chart.png" }],
      }),
      "utf8",
    );
    writeFileSync(join(artifactsDir, "chart.png"), "image", "utf8");
    writeFileSync(join(artifactsDir, "tmp.bin"), "unreferenced", "utf8");

    const bundle = collectRuntimeOutputBundle(workDir);
    assert.ok(bundle);
    assert.deepEqual(
      bundle?.files.map((file) => file.path).sort(),
      [
        "runtime-output/agent-output.json",
        "runtime-output/artifacts/chart.png",
      ],
    );
    assert.equal(
      Buffer.from(bundle?.files.find((file) => file.path.endsWith("chart.png"))?.contentBase64 ?? "", "base64").toString("utf8"),
      "image",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("collectRuntimeOutputBundle uploads only parseable manifest files on parse failure", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));

  try {
    const artifactsDir = join(workDir, "runtime-output", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(workDir, "runtime-output", "agent-output.json"), "{bad", "utf8");
    writeFileSync(join(artifactsDir, "tmp.bin"), "unreferenced", "utf8");

    const bundle = collectRuntimeOutputBundle(workDir);
    assert.deepEqual(
      bundle?.files.map((file) => file.path),
      ["runtime-output/agent-output.json"],
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("collectRuntimeOutputBundle recursively captures referenced skill artifact directories", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));

  try {
    const skillDir = join(workDir, "runtime-output", "artifacts", "skills", "local-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Local\n", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "notes", "utf8");
    writeFileSync(
      join(workDir, "runtime-output", "skill-imports.json"),
      JSON.stringify({
        imports: [{ path: "runtime-output/artifacts/skills/local-skill", conflict: "rename" }],
      }),
      "utf8",
    );

    const bundle = collectRuntimeOutputBundle(workDir);
    assert.deepEqual(
      bundle?.files.map((file) => file.path).sort(),
      [
        "runtime-output/artifacts/skills/local-skill/SKILL.md",
        "runtime-output/artifacts/skills/local-skill/notes.md",
        "runtime-output/skill-imports.json",
      ],
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("collectRuntimeOutputBundle rejects referenced symlink artifacts", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));
  const externalDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-external-"));

  try {
    const artifactsDir = join(workDir, "runtime-output", "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(externalDir, "secret.txt"), "secret", "utf8");
    symlinkSync(join(externalDir, "secret.txt"), join(artifactsDir, "secret.txt"));
    writeFileSync(
      join(workDir, "runtime-output", "agent-output.json"),
      JSON.stringify({
        attachments: [{ path: "runtime-output/artifacts/secret.txt" }],
      }),
      "utf8",
    );

    assert.throws(() => collectRuntimeOutputBundle(workDir), /symlink/i);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("materializeInputBundle restores bundled files into workDir", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));

  try {
    materializeInputBundle(workDir, {
      version: 1,
      format: "json-inline-v1",
      taskId: "task-1",
      runtimeId: "runtime-1",
      prompt: "hi",
      metadata: {
        taskTriggerType: "channel_chat",
      },
      files: [
        {
          path: "attachments/input.txt",
          contentBase64: Buffer.from("hello").toString("base64"),
        },
      ],
    });

    assert.equal(readFileSync(join(workDir, "attachments", "input.txt"), "utf8"), "hello");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
