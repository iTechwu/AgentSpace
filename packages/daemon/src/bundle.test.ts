import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectRuntimeOutputBundle,
  createDaemonBundleFile,
  INPUT_BUNDLE_MAX_FILES,
  materializeInputBundle,
  materializeRemoteInputBundle,
  prepareRemoteOutputBundle,
  readWorkspaceBlobUploadBytes,
} from "./bundle.ts";
import { WORKDIR_CAPTURE_MAX_FILES } from "./workdir-capture.ts";

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
              size: 3,
              sha256: "0".repeat(64),
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

test("collectRuntimeOutputBundle fails closed when the workDir capture is truncated", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));
  mkdirSync(join(workDir, "repository"), { recursive: true });

  try {
    for (let index = 0; index < WORKDIR_CAPTURE_MAX_FILES + 1; index += 1) {
      writeFileSync(join(workDir, "repository", "file-" + String(index).padStart(3, "0") + ".txt"), "x", "utf8");
    }

    assert.throws(() => collectRuntimeOutputBundle(workDir), /output_limit_exceeded/);
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
        createDaemonBundleFile("attachments/input.txt", Buffer.from("hello")),
      ],
    });

    assert.equal(readFileSync(join(workDir, "attachments", "input.txt"), "utf8"), "hello");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("materializeInputBundle verifies every digest before writing any file", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));
  try {
    const valid = createDaemonBundleFile("first.txt", Buffer.from("first"));
    const tampered = { ...createDaemonBundleFile("second.txt", Buffer.from("second")), sha256: "0".repeat(64) };
    assert.throws(
      () => materializeInputBundle(workDir, {
        version: 1,
        format: "json-inline-v1",
        taskId: "task-1",
        runtimeId: "runtime-1",
        prompt: "hi",
        metadata: { taskTriggerType: "channel_chat" },
        files: [valid, tampered],
      }),
      /input_bundle.digest_mismatch/,
    );
    assert.equal(existsSync(join(workDir, "first.txt")), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("materializeInputBundle rejects aggregate file-count overflow", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));
  try {
    const emptyDigest = createDaemonBundleFile("empty", Buffer.alloc(0)).sha256;
    const files = Array.from({ length: INPUT_BUNDLE_MAX_FILES + 1 }, (_, index) => ({
      path: `files/${index}.txt`,
      contentBase64: "",
      size: 0,
      sha256: emptyDigest,
    }));
    assert.throws(
      () => materializeInputBundle(workDir, {
        version: 1,
        format: "json-inline-v1",
        taskId: "task-1",
        runtimeId: "runtime-1",
        prompt: "hi",
        metadata: { taskTriggerType: "channel_chat" },
        files,
      }),
      /input_bundle.file_count_exceeded/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("materializeInputBundle refuses an existing symlink target", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-standalone-daemon-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-agent-bundle-outside-"));
  try {
    symlinkSync(outsideDir, join(workDir, "attachments"));
    assert.throws(
      () => materializeInputBundle(workDir, {
        version: 1,
        format: "json-inline-v1",
        taskId: "task-1",
        runtimeId: "runtime-1",
        prompt: "hi",
        metadata: { taskTriggerType: "channel_chat" },
        files: [createDaemonBundleFile("attachments/escape.txt", Buffer.from("no"))],
      }),
      /input_bundle.symlink_target_forbidden/,
    );
    assert.equal(existsSync(join(outsideDir, "escape.txt")), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("materializeRemoteInputBundle downloads workspace blobs once and reuses the verified cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-remote-input-"));
  const stateDir = join(root, "state");
  const firstWorkDir = join(root, "work-1");
  const secondWorkDir = join(root, "work-2");
  mkdirSync(firstWorkDir, { recursive: true });
  mkdirSync(secondWorkDir, { recursive: true });
  const bytes = Buffer.from("durable workspace", "utf8");
  const file = createDaemonBundleFile("repository/large.txt", bytes, "0640");
  let fetches = 0;
  const bundle = {
    version: 1 as const,
    format: "json-inline-v1" as const,
    taskId: "task-large",
    runtimeId: "runtime-1",
    prompt: "hi",
    metadata: { taskTriggerType: "manual" },
    files: [createDaemonBundleFile("prompt.txt", Buffer.from("hi"))],
    workspace: {
      revisionId: "revision-1",
      manifestDigest: "f".repeat(64),
      files: [{ path: file.path, size: file.size, sha256: file.sha256, mediaType: "text/plain", mode: file.mode }],
    },
  };
  const fetchWorkspaceBlob = async () => {
    fetches += 1;
    return bytes;
  };

  try {
    const first = await materializeRemoteInputBundle({ stateDir, workDir: firstWorkDir, bundle, fetchWorkspaceBlob });
    const second = await materializeRemoteInputBundle({ stateDir, workDir: secondWorkDir, bundle, fetchWorkspaceBlob });
    assert.deepEqual(first, { downloadedBlobs: 1, reusedBlobs: 0 });
    assert.deepEqual(second, { downloadedBlobs: 0, reusedBlobs: 1 });
    assert.equal(fetches, 1);
    assert.equal(readFileSync(join(secondWorkDir, "repository", "large.txt"), "utf8"), "durable workspace");
    assert.equal(readFileSync(join(secondWorkDir, "prompt.txt"), "utf8"), "hi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeRemoteInputBundle rejects a tampered blob before changing the workDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-remote-input-tamper-"));
  const workDir = join(root, "work");
  mkdirSync(workDir, { recursive: true });
  const expected = createDaemonBundleFile("repository/a.txt", Buffer.from("expected"));
  try {
    await assert.rejects(
      materializeRemoteInputBundle({
        stateDir: join(root, "state"),
        workDir,
        bundle: {
          version: 1,
          format: "json-inline-v1",
          taskId: "task-tamper",
          runtimeId: "runtime-1",
          prompt: "hi",
          metadata: { taskTriggerType: "manual" },
          files: [createDaemonBundleFile("prompt.txt", Buffer.from("hi"))],
          workspace: {
            revisionId: "revision-1",
            manifestDigest: "f".repeat(64),
            files: [{ path: expected.path, size: expected.size, sha256: expected.sha256, mediaType: "text/plain" }],
          },
        },
        fetchWorkspaceBlob: async () => Buffer.from("tampered"),
      }),
      /workspace\.blob_mismatch/,
    );
    assert.equal(existsSync(join(workDir, "repository", "a.txt")), false);
    assert.equal(existsSync(join(workDir, "prompt.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRemoteOutputBundle captures more than the legacy 64-file workspace limit without inline bytes", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-large-workspace-output-"));
  mkdirSync(join(workDir, "repository"), { recursive: true });
  try {
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(workDir, "repository", `file-${String(index).padStart(3, "0")}.txt`), `value-${index}`);
    }
    const prepared = prepareRemoteOutputBundle(workDir);
    assert.equal(prepared.uploads.length, 100);
    assert.equal(prepared.bundle?.format, "json-inline-v1");
    assert.equal(prepared.bundle?.workspaceBlobFiles?.length, 100);
    assert.equal(prepared.bundle?.workspaceFiles, undefined);
    assert.equal(
      Buffer.from(readWorkspaceBlobUploadBytes(prepared.uploads[75]!)).toString("utf8"),
      "value-75",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
