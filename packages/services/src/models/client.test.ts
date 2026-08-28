import assert from "node:assert/strict";
import test from "node:test";
import {
  getModelsInternalClient,
  getModelsTenantBillingReportAsync,
  preflightModelsBillingByScopeAsync,
  resetModelsInternalClientForTests,
} from "./client.ts";

test("tenant billing report uses the signed authoritative models route", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    assert.equal(init?.method, "GET");
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        tenantId: "869856a5-760a-4570-9177-8823ed84da78",
        period: {
          startDate: "2026-07-01T00:00:00.000Z",
          endDate: "2026-07-31T00:00:00.000Z",
        },
        totals: [],
        breakdowns: {
          models: [], employees: [], runtimes: [], runtimeCredentials: [], teams: [], conversations: [],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  resetModelsInternalClientForTests();

  try {
    const result = await getModelsTenantBillingReportAsync(
      {
        tenantId: "869856a5-760a-4570-9177-8823ed84da78",
        startDate: "2026-07-01T00:00:00.000Z",
        ssoTeamId: "3b682106-d377-42f8-ad68-5a9b918a4c87",
      },
      {
        MODELS_BASE_URL: "http://models.test/api/",
        MODELS_SERVICE_NAME: "agents-dofe-ai",
        MODELS_INTERNAL_API_SECRET: "test-secret",
      },
    );

    assert.equal(
      requestUrl,
      "http://models.test/api/internal/usage/tenant/869856a5-760a-4570-9177-8823ed84da78/billing-report?startDate=2026-07-01T00%3A00%3A00.000Z&ssoTeamId=3b682106-d377-42f8-ad68-5a9b918a4c87",
    );
    assert.equal(result.tenantId, "869856a5-760a-4570-9177-8823ed84da78");
  } finally {
    globalThis.fetch = originalFetch;
    resetModelsInternalClientForTests();
  }
});

test("tenant usage logs avoid the HTTP redirect that strips service authorization", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    assert.equal(init?.method, "GET");
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /);
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: { list: [], total: 0, page: 1, limit: 100 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  resetModelsInternalClientForTests();

  try {
    const client = getModelsInternalClient({
      MODELS_BASE_URL: "http://model.local.dofe.ai/api",
      MODELS_SERVICE_NAME: "agents-dofe-ai",
      MODELS_INTERNAL_API_SECRET: "test-secret",
    });

    await client.usage.tenantLogs({
      params: { tenantId: "tenant-1" },
      query: { runtimeCredentialId: "credential-1", page: 1, limit: 100 },
    });

    assert.equal(
      requestUrl,
      "https://model.local.dofe.ai/api/internal/usage/tenant/tenant-1/logs?runtimeCredentialId=credential-1&page=1&limit=100",
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetModelsInternalClientForTests();
  }
});

test("tenant-first billing preflight uses the signed v2 internal route", async () => {
  const body = {
    scope: {
      tenantId: "869856a5-760a-4570-9177-8823ed84da78",
      ssoTeamId: "3b682106-d377-42f8-ad68-5a9b918a4c87",
      teamId: null,
      requestId: "runtime-task-1",
      source: "admin" as const,
    },
    estimatedCharge: 0.01,
    reserve: false as const,
  };
  let requestUrl = "";
  let requestInit: RequestInit | undefined;

  const result = await preflightModelsBillingByScopeAsync(
    body,
    {
      MODELS_BASE_URL: "http://models.test/api/",
      MODELS_SERVICE_NAME: "agents-dofe-ai",
      MODELS_INTERNAL_API_SECRET: "test-secret",
    },
    (async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { allowed: true, availableBalance: "100.00", currency: "CNY" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  );

  assert.equal(requestUrl, "http://models.test/api/internal/billing/v2/preflight");
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("x-service-name"), "agents-dofe-ai");
  assert.match(new Headers(requestInit?.headers).get("authorization") ?? "", /^Bearer \d+:[a-f0-9]{64}:agents-dofe-ai$/);
  assert.deepEqual(JSON.parse(String(requestInit?.body)), body);
  assert.deepEqual(result, { allowed: true, availableBalance: "100.00", currency: "CNY" });
});

test("models internal client times out a stalled request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  resetModelsInternalClientForTests();

  try {
    const client = getModelsInternalClient({
      MODELS_BASE_URL: "http://models.test/api/",
      MODELS_SERVICE_NAME: "agents-dofe-ai",
      MODELS_INTERNAL_API_SECRET: "test-secret",
      MODELS_INTERNAL_API_TIMEOUT_MS: "10",
    });
    const testDeadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("test wait exceeded")), 100);
    });

    await assert.rejects(
      Promise.race([
        client.models.list({ query: { tenantId: "tenant-1" } }),
        testDeadline,
      ]),
      /Models internal request timed out after 10ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetModelsInternalClientForTests();
  }
});
