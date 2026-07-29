import { listWorkspacesSync } from "../packages/db/src/workspaces.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../packages/services/src/shared/state-io.ts";
import { localizeLegacySystemTemplateEmployeesSync } from "../packages/services/src/agent-templates/localize-legacy-employees.ts";

let localizedEmployees = 0;
let updatedWorkspaces = 0;

for (const workspace of listWorkspacesSync()) {
  const state = ensureWorkspaceStateSync(workspace.id);
  const updated = localizeLegacySystemTemplateEmployeesSync(state.activeEmployees);
  if (updated === 0) {
    continue;
  }

  writeWorkspaceStateSync(state, workspace.id);
  localizedEmployees += updated;
  updatedWorkspaces += 1;
}

console.log(`Localized ${localizedEmployees} legacy template employee(s) in ${updatedWorkspaces} workspace(s).`);
