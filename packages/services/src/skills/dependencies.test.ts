import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillDependencyDeclarations, parseSkillSkillDependencies } from "./dependencies.ts";

test("parseSkillDependencyDeclarations accepts exact supported dependencies", () => {
  const dependencies = parseSkillDependencyDeclarations(`---
name: github-tooling
dependencies:
  - npm:@modelcontextprotocol/server-filesystem@1.2.3
  - pip:requests==2.32.3
  - uv:ruff==0.8.2
---
# GitHub Tooling
`);

  assert.deepEqual(dependencies, [
    { manager: "npm", name: "@modelcontextprotocol/server-filesystem", version: "1.2.3" },
    { manager: "pip", name: "requests", version: "2.32.3" },
    { manager: "uv", name: "ruff", version: "0.8.2" },
  ]);
});

test("parseSkillDependencyDeclarations rejects ranges and executable declarations", () => {
  assert.throws(
    () => parseSkillDependencyDeclarations(`---
dependencies:
  - npm:some-package@latest
---`),
    /exact version/,
  );
  assert.throws(
    () => parseSkillDependencyDeclarations(`---
dependencies:
  - shell:curl https://example.com/install.sh
---`),
    /Unsupported skill dependency manager/,
  );
});

test("parseSkillSkillDependencies parses a mapping list", () => {
  const deps = parseSkillSkillDependencies(`---
name: novel-production
skillDependencies:
  - coordinate: github:eternityspring/shuohao-skills/skills/novel-outline
    version: "^1.1.0"
    placement: workflow
    required: true
  - coordinate: github:eternityspring/shuohao-skills/skills/novel-art
    version: "^1.1.0"
    placement: same_runtime
    required: true
---
# Novel Production
`);

  assert.deepEqual(deps, [
    { coordinate: "github:eternityspring/shuohao-skills/skills/novel-outline", version: "^1.1.0", placement: "workflow", required: true },
    { coordinate: "github:eternityspring/shuohao-skills/skills/novel-art", version: "^1.1.0", placement: "same_runtime", required: true },
  ]);
});

test("parseSkillSkillDependencies defaults required to true", () => {
  const deps = parseSkillSkillDependencies(`---
skillDependencies:
  - coordinate: github:owner/repo/skills/foo
    version: "^2.0.0"
    placement: same_runtime
---`);
  assert.deepEqual(deps, [
    { coordinate: "github:owner/repo/skills/foo", version: "^2.0.0", placement: "same_runtime", required: true },
  ]);
});

test("parseSkillSkillDependencies rejects bare-name coordinates", () => {
  assert.throws(
    () => parseSkillSkillDependencies(`---
skillDependencies:
  - coordinate: novel-outline
    version: "^1.0.0"
    placement: workflow
---`),
    /scheme prefix/,
  );
});

test("parseSkillSkillDependencies rejects invalid placement and missing version", () => {
  assert.throws(
    () => parseSkillSkillDependencies(`---
skillDependencies:
  - coordinate: github:owner/repo/skills/foo
    version: "^1.0.0"
    placement: everywhere
---`),
    /placement/,
  );
  assert.throws(
    () => parseSkillSkillDependencies(`---
skillDependencies:
  - coordinate: github:owner/repo/skills/foo
    placement: workflow
---`),
    /requires a version/,
  );
});

test("parseSkillSkillDependencies returns empty without the key", () => {
  assert.deepEqual(parseSkillSkillDependencies(`---
name: plain
dependencies:
  - npm:foo@1.2.3
---`), []);
});

test("parseSkillSkillDependencies rejects conflicting declarations for the same coordinate", () => {
  assert.throws(
    () => parseSkillSkillDependencies(`---
skillDependencies:
  - coordinate: github:owner/repo/skills/x
    version: "^1.0.0"
    placement: workflow
    required: true
  - coordinate: github:owner/repo/skills/x
    version: "^2.0.0"
    placement: workflow
    required: true
---`),
    /Conflicting skillDependencies/,
  );
});
