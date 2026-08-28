import assert from "node:assert/strict";
import test from "node:test";
import { attributeBatchFailures, attributeShotFailure } from "./shot-generation.ts";

test("attributeShotFailure classifies missing assets vs temporary errors", () => {
  assert.equal(attributeShotFailure({ shotId: "s1", errorCode: "rate_limited" }), "temporary");
  assert.equal(attributeShotFailure({ shotId: "s2", errorCode: "timeout" }), "temporary");
  assert.equal(
    attributeShotFailure({ shotId: "s3", errorCode: "missing_character", missingCharacters: ["c1"] }),
    "missing_asset",
  );
  assert.equal(
    attributeShotFailure({ shotId: "s4", errorCode: "missing_scene", missingScenes: ["sc1"] }),
    "missing_asset",
  );
});

test("attributeBatchFailures splits retryable failures from asset gaps", () => {
  const attribution = attributeBatchFailures([
    { shotId: "s1", errorCode: "rate_limited" },
    { shotId: "s2", errorCode: "missing_character", missingCharacters: ["c1"] },
    { shotId: "s3", errorCode: "missing_scene", missingScenes: ["sc1"] },
    { shotId: "s4", errorCode: "timeout" },
  ]);

  assert.deepEqual(attribution.retryable.map((failure) => failure.shotId), ["s1", "s4"]);
  assert.equal(attribution.assetGaps.length, 2);
  assert.deepEqual(attribution.assetGaps[0], { shotId: "s2", missingCharacters: ["c1"], missingScenes: [] });
  assert.deepEqual(attribution.assetGaps[1], { shotId: "s3", missingCharacters: [], missingScenes: ["sc1"] });
});

test("attributeBatchFailures records the convergence revision a gap loops back to", () => {
  const attribution = attributeBatchFailures([
    { shotId: "s1", errorCode: "missing_character", missingCharacters: ["c1"], inputRevision: "r2" },
    { shotId: "s2", errorCode: "missing_scene", missingScenes: ["sc1"] },
  ]);

  assert.equal(attribution.assetGaps[0]?.targetRevision, "r2");
  assert.equal(attribution.assetGaps[1]?.targetRevision, undefined, "no inputRevision -> no targetRevision");
});
