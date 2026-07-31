import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvValueRedactions, extractGatewayRequestId, redactText } from "./utils.ts";

test("extractGatewayRequestId ignores generic event and result identifiers", () => {
  assert.equal(extractGatewayRequestId({ id: "message-123" }), undefined);
  assert.equal(extractGatewayRequestId({ result: { id: "response-part-456" } }), undefined);
});

test("extractGatewayRequestId accepts explicit gateway request identifiers", () => {
  assert.equal(extractGatewayRequestId({ gateway_request_id: "gw-1" }), "gw-1");
  assert.equal(extractGatewayRequestId({ result: { requestId: "gw-2" } }), "gw-2");
  assert.equal(extractGatewayRequestId({ usage: { gatewayRequestId: "gw-3" } }), "gw-3");
});

test("buildEnvValueRedactions redacts explicitly listed skill keys regardless of name", () => {
  const env = {
    PATH: "/usr/bin",
    MY_SERVICE_CODE: "super-secret-code",
    NOTION_DATABASE_ID: "db-123",
  };
  const redactions = buildEnvValueRedactions(env, ["MY_SERVICE_CODE", "NOTION_DATABASE_ID"]);

  const scrubbed = redactText("PATH=/usr/bin MY_SERVICE_CODE=super-secret-code db-123", redactions);
  assert.equal(scrubbed.includes("super-secret-code"), false);
  assert.equal(scrubbed.includes("db-123"), false);
  assert.equal(scrubbed.includes("[redacted:MY_SERVICE_CODE]"), true);
  // Keys that are not listed (and not secret-named) are left untouched.
  assert.equal(scrubbed.includes("/usr/bin"), true);
});

test("buildEnvValueRedactions returns nothing when no keys are provided", () => {
  assert.deepEqual(buildEnvValueRedactions({ A: "b" }, undefined), []);
  assert.deepEqual(buildEnvValueRedactions({ A: "b" }, []), []);
});
