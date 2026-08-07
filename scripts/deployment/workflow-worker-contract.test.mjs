import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const composePath = "deploy/self-hosted/docker-compose.yml";
const dockerfilePath = "deploy/workflow-worker/Dockerfile";
const envPath = "deploy/systemd/dofe-agent-workflow-worker.env.example";

test("workflow deployment defines only the worker application and external dependencies", () => {
  const compose = JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", composePath, "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PROVIDER_INSTALL_COMMAND: "true",
          CODEX_PROVIDER_INSTALL_COMMAND: "true",
          CRON_SECRET: "contract-test-only",
          DATABASE_URL: "postgresql://external.invalid/contract_test",
          DOFE_AGENT_ENV_FILE: ".env.example",
          DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY: "contract-test-only",
          NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "contract-test-only",
          WORKFLOW_CUTOVER_MODES: "{}",
        },
      },
    ),
  );
  const services = compose?.services ?? {};
  assert.ok(services["workflow-worker"], "workflow-worker service is required");

  const forbidden = /^(?:postgres(?:ql)?|redis|rabbitmq)(?:[-_]|$)/i;
  for (const [name, service] of Object.entries(services)) {
    assert.equal(forbidden.test(name), false, `forbidden dependency service: ${name}`);
    const image = typeof service === "object" && service && "image" in service ? String(service.image ?? "") : "";
    assert.equal(/(?:postgres(?:ql)?|redis|rabbitmq)(?:[:/@]|$)/i.test(image), false, `forbidden dependency image: ${image}`);
  }

  const dockerfile = readFileSync(dockerfilePath, "utf8");
  assert.match(dockerfile, /@dofe-agent\/workflow-worker/);
  assert.doesNotMatch(dockerfile, /^FROM\s+(?:postgres|redis|rabbitmq)/im);

  const environment = readFileSync(envPath, "utf8");
  assert.match(environment, /^DATABASE_URL=/m);
  assert.match(environment, /^WORKFLOW_WORKER_ID=/m);
  assert.match(environment, /^WORKFLOW_CUTOVER_MODE=/m);
});
