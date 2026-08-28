import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEgressProbeEvidence,
  requiredEnv,
  validateBillingUsageLog,
  validateManagedNetworkInspection,
} from "./managed-runtime-release-gates.mjs";

test("release gates reject example values before contacting staging services", () => {
  assert.throws(
    () => requiredEnv({
      MODELS_BASE_URL: "https://models.example.com",
      STAGING_RUNTIME_ID: "replace_with_runtime_id",
    }, ["MODELS_BASE_URL", "STAGING_RUNTIME_ID"]),
    /placeholder_environment_refused:MODELS_BASE_URL,STAGING_RUNTIME_ID/,
  );
  assert.deepEqual(
    requiredEnv({
      STAGING_RUNTIME_ID: "runtime-managed-1",
      STAGING_EXPECTED_MODEL: "claude-example-model",
    }, ["STAGING_RUNTIME_ID", "STAGING_EXPECTED_MODEL"]),
    {
      STAGING_RUNTIME_ID: "runtime-managed-1",
      STAGING_EXPECTED_MODEL: "claude-example-model",
    },
  );
});

test("managed network evidence requires the configured restricted-egress label", () => {
  const inspection = {
    Name: "dofe-models-egress",
    Driver: "bridge",
    Internal: false,
    Labels: { "dofe.managed-egress": "restricted" },
  };

  assert.deepEqual(
    validateManagedNetworkInspection(inspection, {
      network: "dofe-models-egress",
      policyLabel: "dofe.managed-egress=restricted",
    }),
    {
      name: "dofe-models-egress",
      driver: "bridge",
      internal: false,
      policyLabel: "dofe.managed-egress=restricted",
    },
  );
  assert.throws(
    () => validateManagedNetworkInspection({ ...inspection, Labels: {} }, {
      network: "dofe-models-egress",
      policyLabel: "dofe.managed-egress=restricted",
    }),
    /network_policy_label_mismatch/,
  );
});

test("a TLS failure does not count as blocked when the target TCP port is reachable", () => {
  assert.equal(evaluateEgressProbeEvidence({
    gateway: { reachable: true },
    blockedUrls: [{ reachable: false, tcpReachable: true }],
    blockedIps: [{ reachable: false }],
    blockedProxies: [{ reachable: false }],
    proxyEnvironment: [],
  }), false);
  assert.equal(evaluateEgressProbeEvidence({
    gateway: { reachable: true },
    blockedUrls: [{ reachable: false, tcpReachable: false }],
    blockedIps: [{ reachable: false }],
    blockedProxies: [{ reachable: false }],
    proxyEnvironment: [],
  }), true);
});

test("billing evidence requires full attribution and a terminal billed record", () => {
  const log = {
    id: "usage-1",
    runtimeCredentialId: "rtc-1",
    runtimeId: "runtime-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    requestId: "request-1",
    model: "claude-sonnet-4-6",
    billingStatus: "settled",
    totalCost: "0.0123",
    currency: "USD",
    inputTokens: 120,
    outputTokens: 30,
    cacheTokens: 10,
    timestamp: "2026-07-28T01:00:00.000Z",
  };
  const expected = {
    runtimeCredentialId: "rtc-1",
    runtimeId: "runtime-1",
    employeeId: "employee-1",
    conversationId: "conversation-1",
    requestId: "request-1",
    model: "claude-sonnet-4-6",
  };

  assert.equal(validateBillingUsageLog(log, expected).totalCost, 0.0123);
  assert.throws(
    () => validateBillingUsageLog({ ...log, billingStatus: "pending" }, expected),
    /billing_not_terminal/,
  );
  assert.throws(
    () => validateBillingUsageLog({ ...log, employeeId: "employee-2" }, expected),
    /billing_attribution_mismatch:employeeId/,
  );
  assert.throws(
    () => validateBillingUsageLog({ ...log, id: "" }, expected),
    /gateway_usage_id_missing/,
  );
  assert.throws(
    () => validateBillingUsageLog({ ...log, cacheTokens: undefined, cacheReadTokens: undefined }, expected),
    /cache_tokens_invalid/,
  );
});
