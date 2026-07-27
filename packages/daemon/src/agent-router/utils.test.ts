import assert from "node:assert/strict";
import test from "node:test";
import { extractGatewayRequestId } from "./utils.ts";

test("extractGatewayRequestId ignores generic event and result identifiers", () => {
  assert.equal(extractGatewayRequestId({ id: "message-123" }), undefined);
  assert.equal(extractGatewayRequestId({ result: { id: "response-part-456" } }), undefined);
});

test("extractGatewayRequestId accepts explicit gateway request identifiers", () => {
  assert.equal(extractGatewayRequestId({ gateway_request_id: "gw-1" }), "gw-1");
  assert.equal(extractGatewayRequestId({ result: { requestId: "gw-2" } }), "gw-2");
  assert.equal(extractGatewayRequestId({ usage: { gatewayRequestId: "gw-3" } }), "gw-3");
});
