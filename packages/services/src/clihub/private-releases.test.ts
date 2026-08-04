import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceRuntimeAppReleaseRecord } from "@dofe-agent/db";
import { assessRuntimeAppInstallability, buildRuntimeAppInstallPlan } from "./install-plan.ts";
import { projectPrivateCliRelease, resolveRuntimeAppArtifactMetadata } from "./private-releases.ts";

const release: WorkspaceRuntimeAppReleaseRecord = {
  id: "release-1",
  workspaceId: "workspace-1",
  packageId: "package-1",
  packageSlug: "internal-search",
  displayName: "Internal Search",
  description: "Search internal records",
  category: "developer_tools",
  version: "1.4.2",
  artifactKind: "npm",
  artifactName: "@example/internal-search",
  artifactUrl: "https://registry.npmjs.org/@example/internal-search/-/internal-search-1.4.2.tgz",
  artifactIntegrity: "sha512-dGVzdA==",
  entryPoint: "internal-search",
  manifestJson: "{}",
  risk: "high",
  createdAt: "2026-08-05T00:00:00.000Z",
};

test("private CLI release projects to a controlled, high-risk npm plan", () => {
  const item = projectPrivateCliRelease(release);

  assert.deepEqual(assessRuntimeAppInstallability(item), { status: "installable", requiredTools: ["npm"] });
  const plan = buildRuntimeAppInstallPlan({ item, operation: "install" });
  assert.equal(plan.risk, "high");
  assert.deepEqual(plan.commands, [{
    executable: "npm",
    args: ["install", "--global", "@example/internal-search@1.4.2"],
  }]);
});

test("npm metadata resolution requires integrity and a declared entrypoint", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    version: "1.4.2",
    bin: { "internal-search": "bin/cli.js" },
    dist: {
      tarball: "https://registry.npmjs.org/@example/internal-search/-/internal-search-1.4.2.tgz",
      integrity: "sha512-dGVzdA==",
    },
  }), { status: 200 });

  const metadata = await resolveRuntimeAppArtifactMetadata({
    kind: "npm",
    packageName: "@example/internal-search",
    version: "1.4.2",
    entryPoint: "internal-search",
    fetchImpl,
  });
  assert.equal(metadata.integrity, "sha512-dGVzdA==");
  await assert.rejects(
    resolveRuntimeAppArtifactMetadata({
      kind: "npm",
      packageName: "@example/internal-search",
      version: "1.4.2",
      entryPoint: "other-command",
      fetchImpl,
    }),
    /runtime_app\.entrypoint_not_declared/,
  );
});
