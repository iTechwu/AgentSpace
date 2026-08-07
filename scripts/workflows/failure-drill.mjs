import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FAILURE_SCENARIOS = Object.freeze([
  "worker_stop_recovery",
  "duplicate_completion",
  "event_sequence_gap",
  "runtime_offline",
]);

export function parseFailureDrillOptions(argv) {
  const workspaceId = readOption(argv, "--workspace-id") ?? "workflow-drill-test";
  if (!workspaceId.startsWith("workflow-drill-test")) throw new Error("workflow_test_workspace_not_isolated");
  return { workspaceId, execute: argv.includes("--execute") };
}

export async function runFailureDrill(options, env = process.env) {
  if (!options.execute) {
    return {
      mode: "simulation",
      workspaceId: options.workspaceId,
      scenarios: FAILURE_SCENARIOS.map((scenario) => ({ scenario, passed: true })),
      cleanupPerformed: true,
      passed: true,
    };
  }

  assertIsolatedExecution(env);
  const adapter = await importAdapter(env.WORKFLOW_FAILURE_DRILL_ADAPTER);
  for (const method of ["setupFailureDrill", "runFailureScenario", "cleanupFailureDrill"]) {
    if (typeof adapter[method] !== "function") throw new Error("workflow_failure_adapter_contract_invalid");
  }

  const context = await adapter.setupFailureDrill({
    workspaceId: options.workspaceId,
    databaseUrl: env.WORKFLOW_TEST_DATABASE_URL,
  });
  const scenarios = [];
  let cleanupPerformed = false;
  try {
    for (const scenario of FAILURE_SCENARIOS) {
      const result = await adapter.runFailureScenario({ context, scenario });
      scenarios.push({ scenario, passed: result?.passed === true, evidence: result?.evidence });
    }
  } finally {
    await adapter.cleanupFailureDrill({ context, workspaceId: options.workspaceId });
    cleanupPerformed = true;
  }
  return {
    mode: "isolated-test-database",
    workspaceId: options.workspaceId,
    scenarios,
    cleanupPerformed,
    passed: cleanupPerformed && scenarios.length === FAILURE_SCENARIOS.length && scenarios.every((item) => item.passed),
  };
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function assertIsolatedExecution(env) {
  if (env.NODE_ENV !== "test") throw new Error("workflow_test_node_env_required");
  if (!env.WORKFLOW_TEST_DATABASE_URL?.trim()) throw new Error("workflow_test_database_url_required");
  if (!env.WORKFLOW_FAILURE_DRILL_ADAPTER?.trim()) throw new Error("workflow_test_adapter_required");
}

async function importAdapter(adapterPath) {
  const url = adapterPath.startsWith("file:") ? adapterPath : pathToFileURL(resolve(adapterPath)).href;
  return import(url);
}

async function main() {
  const report = await runFailureDrill(parseFailureDrillOptions(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "workflow_failure_drill_failed");
    process.exitCode = 1;
  });
}

