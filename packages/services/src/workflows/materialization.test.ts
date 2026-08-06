import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkflowEmployeeNameSnapshots } from "./materialization.ts";

test("workflow node snapshots preserve the employee display name instead of the stable id", () => {
  const snapshots = buildWorkflowEmployeeNameSnapshots([
    { id: "employee-1", name: "Atlas", remarkName: "研究员 Atlas" },
    { id: "employee-2", name: "Nova", remarkName: "  " },
  ]);

  assert.equal(snapshots.get("employee-1"), "研究员 Atlas");
  assert.equal(snapshots.get("employee-2"), "Nova");
  assert.equal(snapshots.has("Atlas"), false);
});
