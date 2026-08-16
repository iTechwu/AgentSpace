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
    source: { kind: "daemon_probe", daemonKey: "daemon-a", observedAt: "2026-08-17T08:00:00+00:00" },
  }), {
    schemaVersion: 1,
    gpu: true,
    egress: false,
    mcp: ["catalog-a", "catalog-b"],
    cli: [],
    source: { kind: "daemon_probe", daemonKey: "daemon-a", observedAt: "2026-08-17T08:00:00.000Z" },
  });
});

test("parseRuntimeCapabilitySnapshot rejects malformed, blank, or duplicate slugs", () => {
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 2, gpu: true, egress: true, mcp: [], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [""], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: ["catalog-a", "catalog-a"], cli: [] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [], cli: ["catalog-cli", 1] }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [], cli: [], source: { kind: "daemon_probe", daemonKey: "", observedAt: "2026-08-17T08:00:00Z" } }), null);
  assert.equal(parseRuntimeCapabilitySnapshot({ schemaVersion: 1, gpu: true, egress: true, mcp: [], cli: [], source: { kind: "daemon_probe", daemonKey: "daemon-a", observedAt: "not-a-date" } }), null);
});
