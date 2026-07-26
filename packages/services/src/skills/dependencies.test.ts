import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillDependencyDeclarations } from "./dependencies.ts";

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
