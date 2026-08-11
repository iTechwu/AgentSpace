import assert from "node:assert/strict";
import test from "node:test";
import { compareTemplateVersions } from "./template-version.ts";

test("template versions compare numeric SemVer segments", () => {
  assert.equal(compareTemplateVersions("10.0.0", "9.0.0") > 0, true);
  assert.equal(compareTemplateVersions("1.10.0", "1.9.0") > 0, true);
});

test("release versions sort after prereleases", () => {
  assert.equal(compareTemplateVersions("1.0.0", "1.0.0-rc.1") > 0, true);
  assert.equal(compareTemplateVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0, true);
});

test("valid versions sort above malformed legacy values", () => {
  assert.equal(compareTemplateVersions("2.0.0", "latest") > 0, true);
});
