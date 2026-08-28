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
  assert.ok(resolveSystemDependencySync("curl")?.binaries.includes("curl"));
  assert.equal(resolveSystemDependencySync("sudo"), null, "unknown package is rejected");
});

test("parseSkillDependencyDeclaration accepts cataloged system:<name> and rejects unknown", () => {
  const parsed = parseSkillDependencyDeclaration("system:graphviz");
  assert.equal(parsed.manager, "system");
  assert.equal(parsed.name, "graphviz");
  assert.equal(parsed.version, "system");

  assert.deepEqual(parseSkillDependencyDeclaration("system:curl"), {
    manager: "system",
    name: "curl",
    version: "system",
  });

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

test("resolveSystemDependencySync returns the binary set to probe, not the package name", () => {
  const graphviz = resolveSystemDependencySync("graphviz");
  assert.deepEqual(graphviz?.binaries, ["dot", "neato"]);
  assert.ok(!graphviz?.binaries.includes("graphviz"));

  const poppler = resolveSystemDependencySync("poppler-utils");
  assert.ok(poppler?.binaries.includes("pdftoppm"));
  assert.ok(poppler?.binaries.includes("pdfinfo"));
  assert.ok(!poppler?.binaries.includes("poppler-utils"));
});

test("resolveSystemDependencySync exposes probeMode (all = suite, any = alternative names)", () => {
  // Multi-tool suites: every binary required.
  assert.equal(resolveSystemDependencySync("ffmpeg")?.probeMode, "all");
  assert.equal(resolveSystemDependencySync("graphviz")?.probeMode, "all");
  assert.equal(resolveSystemDependencySync("poppler-utils")?.probeMode, "all");
  // Alternative names: any one binary suffices.
  assert.equal(resolveSystemDependencySync("imagemagick")?.probeMode, "any");
  assert.equal(resolveSystemDependencySync("libreoffice")?.probeMode, "any");
  assert.equal(resolveSystemDependencySync("chromium")?.probeMode, "any");
  // Single-binary entries default to "all" (trivially satisfied).
  assert.equal(resolveSystemDependencySync("curl")?.probeMode, "all");
  assert.equal(resolveSystemDependencySync("jq")?.probeMode, "all");
});

test("listSystemDependencyCatalogSync surfaces probeMode for every entry", () => {
  const catalog = listSystemDependencyCatalogSync();
  assert.ok(catalog.every((entry) => entry.probeMode === "all" || entry.probeMode === "any"));
  assert.ok(
    catalog.find((entry) => entry.name === "ffmpeg")?.probeMode === "all",
    "ffmpeg is an all-binary suite",
  );
  assert.ok(
    catalog.find((entry) => entry.name === "imagemagick")?.probeMode === "any",
    "imagemagick accepts alternative names",
  );
});
