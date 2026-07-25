import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceStateConflictError,
  getDatabase,
  readWorkspaceStateCurrentVersionSync,
  readWorkspaceStateVersion,
} from "@dofe-agent/db";
import {
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "@dofe-agent/services";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-workspace-state-versioning-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM workspace_snapshot");
  resetWorkspaceStateSync();
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("workspace state versioning", () => {
  it("attaches and increments workspace state versions", () => {
    const state = readWorkspaceStateSync();
    const version = readWorkspaceStateVersion(state);

    expect(version).toBe(1);

    state.organizationName = "Northstar Labs";
    const written = writeWorkspaceStateSync(state);

    expect(readWorkspaceStateVersion(written)).toBe(2);
    expect(readWorkspaceStateCurrentVersionSync()).toBe(2);
  });

  it("rejects stale writes instead of silently overriding newer state", () => {
    const firstReaderState = readWorkspaceStateSync();
    const secondReaderState = { ...readWorkspaceStateSync() };

    firstReaderState.organizationName = "Workspace A";
    writeWorkspaceStateSync(firstReaderState);

    secondReaderState.organizationName = "Workspace B";

    expect(() => writeWorkspaceStateSync(secondReaderState)).toThrow(WorkspaceStateConflictError);
    expect(readWorkspaceStateCurrentVersionSync()).toBe(2);
    expect(readWorkspaceStateSync().organizationName).toBe("Workspace A");
  });
});
