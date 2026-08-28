import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const LOAD_LIMITS = Object.freeze({ triggers: 1_000, runs: 100, concurrency: 20 });

export function parseLoadOptions(argv) {
  const options = {
    workspaceId: readOption(argv, "--workspace-id") ?? "workflow-load-test",
    triggers: integerOption(argv, "--triggers", LOAD_LIMITS.triggers),
    runs: integerOption(argv, "--runs", LOAD_LIMITS.runs),
    concurrency: integerOption(argv, "--concurrency", LOAD_LIMITS.concurrency),
    execute: argv.includes("--execute"),
  };
  assertSafeWorkspace(options.workspaceId, "workflow-load-test");
  assertBounded("triggers", options.triggers, LOAD_LIMITS.triggers);
  assertBounded("runs", options.runs, LOAD_LIMITS.runs);
  assertBounded("concurrency", options.concurrency, LOAD_LIMITS.concurrency);
  return options;
}

export function simulateWorkflowLoad(options) {
  const latencies = Array.from({ length: options.runs }, (_, index) => 4 + ((index * 17 + options.concurrency) % 48));
  return buildReport(options, {
    latencies,
    duplicateRuns: 0,
    duplicateDownstreamTasks: 0,
    outboxBacklog: 0,
  }, "simulation");
}

export async function runWorkflowLoad(options, env = process.env) {
  if (!options.execute) return simulateWorkflowLoad(options);
  assertIsolatedExecution(env, "WORKFLOW_LOAD_TEST_ADAPTER");
  const adapter = await importAdapter(env.WORKFLOW_LOAD_TEST_ADAPTER);
  if (typeof adapter.runWorkflowLoadTest !== "function") throw new Error("workflow_load_adapter_contract_invalid");
  const result = await adapter.runWorkflowLoadTest({ ...options, databaseUrl: env.WORKFLOW_TEST_DATABASE_URL });
  return buildReport(options, result, "isolated-test-database");
}

function buildReport(options, result, mode) {
  const latencies = Array.isArray(result.latencies) ? result.latencies.filter(Number.isFinite) : [];
  if (latencies.length !== options.runs) throw new Error("workflow_load_result_run_count_mismatch");
  const report = {
    mode,
    workspaceId: options.workspaceId,
    limits: { ...LOAD_LIMITS },
    requested: { triggers: options.triggers, runs: options.runs, concurrency: options.concurrency },
    triggerLagSeconds: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    duplicateRuns: nonNegativeInteger(result.duplicateRuns),
    duplicateDownstreamTasks: nonNegativeInteger(result.duplicateDownstreamTasks),
    outboxBacklog: nonNegativeInteger(result.outboxBacklog),
  };
  report.passed = report.triggerLagSeconds.p95 <= 60
    && report.duplicateRuns === 0
    && report.duplicateDownstreamTasks === 0
    && report.outboxBacklog === 0;
  return report;
}

function percentile(values, percent) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function integerOption(argv, name, fallback) {
  const raw = readOption(argv, name);
  return raw === undefined ? fallback : Number(raw);
}

function assertBounded(name, value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`workflow_load_${name}_out_of_bounds`);
}

function assertSafeWorkspace(workspaceId, prefix) {
  if (!workspaceId.startsWith(prefix)) throw new Error("workflow_test_workspace_not_isolated");
}

function assertIsolatedExecution(env, adapterVariable) {
  if (env.NODE_ENV !== "test") throw new Error("workflow_test_node_env_required");
  if (!env.WORKFLOW_TEST_DATABASE_URL?.trim()) throw new Error("workflow_test_database_url_required");
  if (!env[adapterVariable]?.trim()) throw new Error("workflow_test_adapter_required");
}

async function importAdapter(adapterPath) {
  const url = adapterPath.startsWith("file:") ? adapterPath : pathToFileURL(resolve(adapterPath)).href;
  return import(url);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

async function main() {
  const report = await runWorkflowLoad(parseLoadOptions(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "workflow_load_test_failed");
    process.exitCode = 1;
  });
}

