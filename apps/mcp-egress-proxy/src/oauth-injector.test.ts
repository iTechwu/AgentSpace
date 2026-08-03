import assert from "node:assert/strict";
import test from "node:test";
import { OAuthInjector } from "./oauth-injector.ts";

test("OAuth injector exchanges an opaque grant reference for a short-lived token", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const injector = new OAuthInjector({
    brokerUrl: "https://oauth-broker.example.com",
    brokerToken: "broker-service-token",
    fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer broker-service-token");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ accessToken: "short-lived", tokenType: "Bearer", expiresIn: 300 });
    },
  });

  const result = await injector.inject("oauth_proxy", "grant-ref-1", {
    workspaceId: "ws-1",
    runtimeId: "runtime-1",
    connectionId: "connection-1",
    taskId: "task-1",
  });

  assert.deepEqual(result.headers, { Authorization: "Bearer short-lived" });
  assert.deepEqual(requestBody, {
    grantReference: "grant-ref-1",
    workspaceId: "ws-1",
    runtimeId: "runtime-1",
    connectionId: "connection-1",
    taskId: "task-1",
  });
});

test("OAuth injector fails closed without a broker, grant, or valid token", async () => {
  await assert.rejects(
    () => new OAuthInjector().inject("oauth_proxy", "grant-1", {
      workspaceId: "ws-1", runtimeId: "runtime-1", connectionId: "connection-1",
    }),
    /unavailable/,
  );
  await assert.rejects(
    () => new OAuthInjector({
      brokerUrl: "https://oauth-broker.example.com",
      brokerToken: "token",
      fetchImpl: async () => Response.json({ accessToken: "", expiresIn: 7200 }),
    }).inject("oauth_proxy", "grant-1", {
      workspaceId: "ws-1", runtimeId: "runtime-1", connectionId: "connection-1",
    }),
    /invalid short-lived token/,
  );
  await assert.rejects(
    () => new OAuthInjector({
      brokerUrl: "https://oauth-broker.example.com",
      brokerToken: "token",
      fetchImpl: async () => Response.json({ accessToken: "token-without-expiry" }),
    }).inject("oauth_proxy", "grant-1", {
      workspaceId: "ws-1", runtimeId: "runtime-1", connectionId: "connection-1",
    }),
    /invalid short-lived token/,
  );
  await assert.rejects(
    () => new OAuthInjector({
      brokerUrl: "https://oauth-broker.example.com",
      brokerToken: "token",
      fetchImpl: async () => new Response("x".repeat(16_385)),
    }).inject("oauth_proxy", "grant-1", {
      workspaceId: "ws-1", runtimeId: "runtime-1", connectionId: "connection-1",
    }),
    /invalid short-lived token/,
  );
});

test("OAuth injector rejects insecure broker URLs by default", () => {
  assert.throws(() => new OAuthInjector({ brokerUrl: "http://oauth-broker.example.com", brokerToken: "token" }), /invalid/);
});
