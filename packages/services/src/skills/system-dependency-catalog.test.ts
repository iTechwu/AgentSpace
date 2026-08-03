import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillDependencyDeclaration } from "./dependencies.ts";
import { buildSkillDependencyInstallPlan } from "./dependency-install.ts";
import { listSystemDependencyCatalogSync, resolveSystemDependencySync } from "./system-dependency-catalog.ts";

test("resolveSystemDependencySync resolves a cataloged system package", () => {
  const resolved = resolveSystemDependencySync("ffmpeg");
  assert.ok(resolved);
  assert.equal(resolved.name, "ffmpeg");
  assert.ok(resolved.binaries.includes("ffmpeg"));
  assert.ok(resolved.packageManagers.some((entry) => entry.manager === "apt" && entry.package === "ffmpeg"));
  assert.equal(resolved.allowInstall, true);
});

test("resolveSystemDependencySync resolves aliases and fails closed on unknown packages", () => {
  assert.ok(resolveSystemDependencySync("pdftoppm")?.name === "poppler-utils");
  assert.equal(resolveSystemDependencySync("sudo"), null, "unknown package is rejected");
  assert.equal(resolveSystemDependencySync("curl"), null, "not-yet-cataloged package is rejected");
});

test("parseSkillDependencyDeclaration accepts cataloged system:<name> and rejects unknown", () => {
  const parsed = parseSkillDependencyDeclaration("system:graphviz");
  assert.equal(parsed.manager, "system");
  assert.equal(parsed.name, "graphviz");
  assert.equal(parsed.version, "system");

  assert.throws(
    () => parseSkillDependencyDeclaration("system:htop"),
    /allow-list catalog/,
  );
  assert.throws(
    () => parseSkillDependencyDeclaration("system:ffmpeg@1.0"),
    /Use system:ffmpeg/,
  );
});

test("buildSkillDependencyInstallPlan for a system dependency verifies the binary without installing", () => {
  const plan = buildSkillDependencyInstallPlan("skill-1", {
    manager: "system",
    name: "ffmpeg",
    version: "system",
  });
  assert.equal(plan.strategy, "system");
  assert.deepEqual(plan.commands, [], "system packages come from the runner image, nothing is installed");
  assert.deepEqual(plan.verifyCommands, [{ executable: "sh", args: ["-c", "command -v ffmpeg || exit 1"] }]);
  assert.equal(plan.depsDir, undefined);
  assert.ok(plan.notes.some((note) => note.includes("immutable runner image")));
});

test("listSystemDependencyCatalogSync exposes the curated allow-list", () => {
  const catalog = listSystemDependencyCatalogSync();
  assert.ok(catalog.length >= 5);
  assert.ok(catalog.every((entry) => entry.allowInstall === true));
  assert.ok(catalog.every((entry) => entry.binaries.length > 0));
});
