import assert from "node:assert/strict";
import test from "node:test";
import { parseLiveEgressPolicyServiceIds } from "./skill-runner-docker.ts";

/**
 * Unit coverage for the live-owner parser. The broker suite injects a pre-built
 * `Set` at the `enumerateLiveEgressPolicyOwners` seam, so it never exercises the
 * real `docker ps` parse — which is exactly how the P0 regression (live set
 * always empty → sweep revoked running Runners' firewalls) went uncaught. These
 * cases pin the parser against captured real-Docker output; the full docker path
 * is guarded by the REAL-DOCKER e2e in skill-runner.e2e-real-docker.test.ts.
 */
test("parseLiveEgressPolicyServiceIds reads one serviceId per line from real {{.Label}} output", () => {
  // Exact shape emitted by `docker ps --filter label=<lbl> --format '{{.Label "<lbl>"}}'`:
  // each still-running Runner prints its egress-policy serviceId on its own line.
  const stdout = "run-lease-aaa\nrun-lease-bbb\n";
  assert.deepEqual(
    [...parseLiveEgressPolicyServiceIds(stdout)].sort(),
    ["run-lease-aaa", "run-lease-bbb"],
  );
});

test("parseLiveEgressPolicyServiceIds trims whitespace and skips blank lines", () => {
  const stdout = "\n  run-lease-aaa  \n\n   \nrun-lease-bbb\n";
  assert.deepEqual(
    [...parseLiveEgressPolicyServiceIds(stdout)].sort(),
    ["run-lease-aaa", "run-lease-bbb"],
  );
});

test("parseLiveEgressPolicyServiceIds is empty when no live Runner carries the label", () => {
  assert.equal(parseLiveEgressPolicyServiceIds("").size, 0);
  assert.equal(parseLiveEgressPolicyServiceIds("\n   \n\t\n").size, 0);
});
