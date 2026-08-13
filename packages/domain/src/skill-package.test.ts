import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSkillManifestRuntimes,
  inferSkillEntrypointRuntimeForPath,
} from "./skill-package.ts";

test("inferSkillEntrypointRuntimeForPath maps script extensions to runtimes", () => {
  assert.equal(inferSkillEntrypointRuntimeForPath("a.js"), "node");
  assert.equal(inferSkillEntrypointRuntimeForPath("b.MJS"), "node");
  assert.equal(inferSkillEntrypointRuntimeForPath("c.ts"), "node");
  assert.equal(inferSkillEntrypointRuntimeForPath("d.mts"), "node");
  assert.equal(inferSkillEntrypointRuntimeForPath("dir/e.py"), "python");
  assert.equal(inferSkillEntrypointRuntimeForPath("f.sh"), "bash");
  assert.equal(inferSkillEntrypointRuntimeForPath("g.bash"), "bash");
  assert.equal(inferSkillEntrypointRuntimeForPath("h.bin"), undefined);
  assert.equal(inferSkillEntrypointRuntimeForPath("README.md"), undefined);
});

test("collectSkillManifestRuntimes merges declared and implicit entrypoint runtimes", () => {
  assert.deepEqual(collectSkillManifestRuntimes({}), []);
  assert.deepEqual(
    collectSkillManifestRuntimes({
      entrypoints: [{ runtime: "python" }, { runtime: "python" }, { runtime: "ruby" }],
    }),
    ["python"],
    "unknown runtimes are ignored",
  );
  // Implicit entrypoints: 0755 files with a known script extension, mirroring
  // the provider projection. Non-executable files never contribute.
  assert.deepEqual(
    collectSkillManifestRuntimes({
      entrypoints: [{ runtime: "node" }],
      files: [
        { path: "scripts/fetch.py", mode: "0755" },
        { path: "scripts/run.sh", mode: "0755" },
        { path: "scripts/helper.py", mode: "0644" },
        { path: "assets/logo.png", mode: "0755" },
      ],
    }),
    ["node", "python", "bash"],
  );
});

test("collectSkillManifestRuntimes does not re-infer a declared entrypoint's extension", () => {
  // run.py is explicitly declared as a bash entrypoint: its .py extension must
  // NOT additionally imply python, which would needlessly require the python
  // Runner image + python deps even though execution only uses bash.
  assert.deepEqual(
    collectSkillManifestRuntimes({
      entrypoints: [{ path: "scripts/run.py", runtime: "bash" }],
      files: [{ path: "scripts/run.py", mode: "0755" }],
    }),
    ["bash"],
    "a declared entrypoint path is excluded from extension inference",
  );
  // A second implicit .py file is still inferred; only the declared path is exempt.
  assert.deepEqual(
    collectSkillManifestRuntimes({
      entrypoints: [{ path: "scripts/run.py", runtime: "bash" }],
      files: [
        { path: "scripts/run.py", mode: "0755" },
        { path: "scripts/helper.py", mode: "0755" },
      ],
    }),
    ["bash", "python"],
  );
});
