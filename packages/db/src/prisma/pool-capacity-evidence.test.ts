import assert from "node:assert/strict";
import test from "node:test";
import { collectPrismaPoolCapacityEvidence } from "./pool-capacity-evidence.ts";

test("pool capacity evidence records role limits and observed waiting connections", async () => {
  const evidence = await collectPrismaPoolCapacityEvidence({
    env: {
      DOFE_AGENT_PRISMA_POOL_MAX: "7",
    },
    query: async () => ({
      rows: [
        { application_name: "agentspace-web", state: "active", waiting: true, count: 2 },
        { application_name: "agentspace-web", state: "idle", waiting: false, count: 1 },
        { application_name: "agentspace-worker", state: "active", waiting: false, count: 3 },
        { application_name: "unrelated", state: "active", waiting: false, count: 99 },
      ],
    }),
  });
  assert.deepEqual(evidence.roles, [
    {
      role: "web",
      applicationName: "agentspace-web",
      configuredPoolMax: 7,
      observedConnections: 3,
      activeConnections: 2,
      idleConnections: 1,
      waitingConnections: 2,
    },
    {
      role: "worker",
      applicationName: "agentspace-worker",
      configuredPoolMax: 7,
      observedConnections: 3,
      activeConnections: 3,
      idleConnections: 0,
      waitingConnections: 0,
    },
    {
      role: "daemon",
      applicationName: "agentspace-daemon",
      configuredPoolMax: 7,
      observedConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
      waitingConnections: 0,
    },
  ]);
});
