import { readFileSync } from "node:fs";
import {
  applyLegacyMigrationSync,
  listActiveEmployeesSync,
  planLegacyMigration,
  readWorkspaceStateSnapshotSync,
} from "../../packages/services/src/index.ts";

interface CliOptions {
  workspaceId: string;
  apply: boolean;
  inputFile?: string;
}

const options = parseOptions(process.argv.slice(2));
const state = options.inputFile
  ? JSON.parse(readFileSync(options.inputFile, "utf8")) as { scheduledTasks?: []; automationRules?: []; activeEmployees?: [] }
  : readWorkspaceStateSnapshotSync(options.workspaceId);
const plan = planLegacyMigration({
  workspaceId: options.workspaceId,
  scheduledTasks: state.scheduledTasks ?? [],
  automationRules: state.automationRules ?? [],
  employees: options.inputFile ? state.activeEmployees ?? [] : listActiveEmployeesSync(options.workspaceId),
  strictEmployeeResolution: true,
});
const report = applyLegacyMigrationSync({ workspaceId: options.workspaceId, plan, dryRun: !options.apply });
process.stdout.write(`${JSON.stringify({ mode: options.apply ? "apply" : "dry-run", plan: plan.counts, report }, null, 2)}\n`);

function parseOptions(args: string[]): CliOptions {
  let workspaceId = "default";
  let apply = false;
  let inputFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--workspace-id") workspaceId = requireValue(args, ++index, arg);
    else if (arg === "--input-file") inputFile = requireValue(args, ++index, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!workspaceId.trim()) throw new Error("--workspace-id requires a non-empty value");
  return { workspaceId, apply, ...(inputFile ? { inputFile } : {}) };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}
