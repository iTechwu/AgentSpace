import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeCapabilitySnapshot } from "./skill-package.ts";

test("parseRuntimeCapabilitySnapshot normalizes valid capability metadata", () => {
  assert.deepEqual(parseRuntimeCapabilitySnapshot({
    schemaVersion: 1,
    gpu: true,
    egress: false,
    mcp: ["catalog-b", "catalog-a"],
    cli: [],
  }), {
    schemaVersion: 1,
    gpu: true,
    egress: false,
    mcp: ["catalog-a", "catalog-b"],
    cli: [],
  });
});

test("parseRuntimeCapabilitySnapshot rejects malformed, blank, or duplicate slugs", () => {
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 2, gpu: true, egress: true, mcp: [], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [""], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: ["catalog-a", "catalog-a"], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [], cli: ["catalog-cli", 1] }), null);
});
