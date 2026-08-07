import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setAttachmentStorageClientForTests } from "@dofe-agent/services";
import { createTestTosAttachmentStorage } from "@/test-utils/tos-attachment-storage";
import {
  clearDaemonTaskOutputStaging,
  getDaemonTaskOutputStagingDir,
  materializeOutputBundleToStaging,
  readTaskCompletionEffectsSnapshot,
  writeTaskCompletionEffectsSnapshot,
} from "./output-bundle";

const workspaceId = "workspace-output-bundle-test";
const taskId = "task-output-bundle-test";
const testStorage = createTestTosAttachmentStorage();

beforeAll(() => setAttachmentStorageClientForTests(testStorage.client));
afterAll(() => setAttachmentStorageClientForTests(undefined));

afterEach(() => {
  testStorage.clear();
  rmSync(getDaemonTaskOutputStagingDir(taskId, workspaceId), { recursive: true, force: true });
});

describe("materializeOutputBundleToStaging", () => {
  it("accepts runtime-output bundle files", () => {
    const stagingDir = materializeOutputBundleToStaging(taskId, workspaceId, {
      version: 1,
      format: "json-inline-v1",
      files: [
        {
          path: "runtime-output/agent-output.json",
          contentBase64: Buffer.from(JSON.stringify({ text: "done" }), "utf8").toString("base64"),
        },
      ],
    });

    expect(existsSync(join(stagingDir, "runtime-output", "agent-output.json"))).toBe(true);
  });

  it("rejects paths outside runtime-output", () => {
    expect(() =>
      materializeOutputBundleToStaging(taskId, workspaceId, {
        version: 1,
        format: "json-inline-v1",
        files: [
          {
            path: "artifacts/chart.png",
            contentBase64: Buffer.from("bad", "utf8").toString("base64"),
          },
        ],
      }),
    ).toThrow(/runtime-output/i);
  });

  it("rejects too many bundle files", () => {
    expect(() =>
      materializeOutputBundleToStaging(taskId, workspaceId, {
        version: 1,
        format: "json-inline-v1",
        files: Array.from({ length: 65 }, (_, index) => ({
          path: `runtime-output/artifacts/file-${index}.txt`,
          contentBase64: Buffer.from("x", "utf8").toString("base64"),
        })),
      }),
    ).toThrow(/too many files/i);
  });

  it("materializes a content-addressed workspace manifest after verifying every blob", () => {
    const bytes = Buffer.from("large workspace content", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    testStorage.client.putContentAddressedBlobSync({ workspaceId, sha256, contentBytes: bytes });
    const stagingDir = materializeOutputBundleToStaging(taskId, workspaceId, {
      version: 1,
      format: "json-inline-v1",
      files: [],
      workspaceBlobFiles: [{ path: "repository/large.txt", sha256, size: bytes.byteLength, mode: "0640" }],
    });
    expect(readFileSync(join(stagingDir, "repository", "large.txt"), "utf8")).toBe("large workspace content");
  });

  it("clears staging when a workspace blob is missing", () => {
    expect(() => materializeOutputBundleToStaging(taskId, workspaceId, {
      version: 1,
      format: "json-inline-v1",
      files: [],
      workspaceBlobFiles: [{ path: "repository/missing.txt", sha256: "0".repeat(64), size: 1 }],
    })).toThrow();
    expect(existsSync(getDaemonTaskOutputStagingDir(taskId, workspaceId))).toBe(false);
  });

  it("persists replay-only completion effects until staging is cleared", () => {
    writeTaskCompletionEffectsSnapshot(taskId, workspaceId, { documentUpdates: ["version-1"] });

    expect(readTaskCompletionEffectsSnapshot(taskId, workspaceId)).toEqual({ documentUpdates: ["version-1"] });

    clearDaemonTaskOutputStaging(taskId, workspaceId);
    expect(readTaskCompletionEffectsSnapshot(taskId, workspaceId)).toBeNull();
  });

  it("preserves the completion checkpoint when a promotion retry rematerializes its bundle", () => {
    materializeOutputBundleToStaging(taskId, workspaceId, {
      version: 1,
      format: "json-inline-v1",
      files: [{
        path: "runtime-output/agent-output.json",
        contentBase64: Buffer.from(JSON.stringify({ text: "original" }), "utf8").toString("base64"),
      }],
    });
    writeTaskCompletionEffectsSnapshot(taskId, workspaceId, { documentUpdates: ["version-1"] });

    materializeOutputBundleToStaging(taskId, workspaceId, {
      version: 1,
      format: "json-inline-v1",
      files: [{
        path: "runtime-output/agent-output.json",
        contentBase64: Buffer.from(JSON.stringify({ text: "tampered" }), "utf8").toString("base64"),
      }],
    });

    expect(readTaskCompletionEffectsSnapshot(taskId, workspaceId)).toEqual({ documentUpdates: ["version-1"] });
    expect(JSON.parse(readFileSync(join(getDaemonTaskOutputStagingDir(taskId, workspaceId), "runtime-output", "agent-output.json"), "utf8")))
      .toEqual({ text: "original" });
  });
});
