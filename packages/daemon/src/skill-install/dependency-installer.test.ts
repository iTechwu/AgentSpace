import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import type { ExecResult } from "@dofe-agent/sandbox";
import {
  buildDependencyInstallCommand,
  buildInstallEnv,
  installSkillDependenciesSync,
  resolveDependencyRegistries,
  type SandboxLike,
} from "./dependency-installer.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempEnvsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dofe-agent-dep-envs-"));
  cleanups.push(dir);
  return dir;
}

function fakeSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
  return {
    async exec(): Promise<ExecResult> {
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    },
    async readFile(_path: string): Promise<string> {
      throw new Error("not implemented");
    },
    async readDir(_path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
      return [];
    },
    ...overrides,
  };
}

test("planner generates isolated install commands with exact versions and allow-listed registries", () => {
  const envsDir = "/tmp/envs";
  const registries = { npm: "https://registry.npmjs.org", pip: "https://pypi.org/simple", uv: "https://pypi.org/simple" };

  const npm = buildDependencyInstallCommand({ manager: "npm", name: "lodash", version: "4.17.21" }, envsDir, registries);
  assert.deepEqual(npm.args, [
    "install", "--prefix", envsDir, "--ignore-scripts", "--no-audit", "--no-fund",
    "--registry", registries.npm, "lodash@4.17.21",
  ]);
  assert.ok(!npm.args.includes("--global"), "npm must never install --global");

  const pip = buildDependencyInstallCommand({ manager: "pip", name: "requests", version: "2.31.0" }, envsDir, registries);
  assert.ok(pip.args.includes("--target") && pip.args.includes("--only-binary") && pip.args.includes(":all:"), "pip targets envs dir, binary-only");
  assert.ok(pip.args.includes("--index-url") && pip.args.includes(registries.pip));
  assert.ok(!pip.args.includes("--user"), "pip must never install --user");
  assert.ok(pip.args.includes("requests==2.31.0"), "pip pins the exact version");

  const uv = buildDependencyInstallCommand({ manager: "uv", name: "requests", version: "2.31.0" }, envsDir, registries);
  assert.ok(uv.args.includes("--target") && uv.args.includes("requests==2.31.0"));
});

test("registry allow-list is platform-configured and env-overridable, never manifest-supplied", () => {
  const defaults = resolveDependencyRegistries({});
  assert.equal(defaults.npm, "https://registry.npmjs.org");
  assert.equal(defaults.pip, "https://pypi.org/simple");

  const overridden = resolveDependencyRegistries({
    DOFE_AGENT_NPM_REGISTRY: "https://mirror.example.com/npm",
    DOFE_AGENT_PYPI_INDEX_URL: "https://mirror.example.com/pypi",
  });
  assert.equal(overridden.npm, "https://mirror.example.com/npm");
  assert.equal(overridden.pip, "https://mirror.example.com/pypi");
  assert.equal(overridden.uv, "https://mirror.example.com/pypi");
});

test("install env is minimal and strips secrets", () => {
  const env = buildInstallEnv("/tmp/envs", {
    PATH: "/usr/bin",
    DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY: "super-secret",
    TOS_ACCESS_KEY: "secret",
    DATABASE_URL: "postgres://secret",
    HOME: "/root",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NPM_CONFIG_CACHE", "PATH", "PIP_CACHE_DIR"]);
  assert.equal(env.HOME, "/tmp/envs");
  assert.ok(!env.DOFE_AGENT_RUNTIME_CREDENTIAL_ENCRYPTION_KEY);
  assert.ok(!env.TOS_ACCESS_KEY);
  assert.ok(!env.DATABASE_URL);
});

test("verify passes when the installed package/version is present in the envs dir", async () => {
  const envsDir = tempEnvsDir();
  // The fake install command writes the installed artifacts into the envs dir
  // (the installer wipes it first), then the independent verify reads them.
  const sandbox = fakeSandbox({
    async exec() {
      mkdirSync(join(envsDir, "node_modules", "lodash"), { recursive: true });
      writeFileSync(join(envsDir, "node_modules", "lodash", "package.json"), JSON.stringify({ name: "lodash", version: "4.17.21" }));
      mkdirSync(join(envsDir, "requests-2.31.0.dist-info"), { recursive: true });
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };
    },
    async readFile(path: string) {
      return readFileSync(path, "utf8");
    },
    async readDir(path: string) {
      return readdirSync(path, { withFileTypes: true }).map((entry: { name: string; isDirectory: () => boolean }) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    },
  });

  const results = await installSkillDependenciesSync({
    dependencies: [
      { manager: "npm", name: "lodash", version: "4.17.21" },
      { manager: "pip", name: "requests", version: "2.31.0" },
    ],
    envsDir,
    sandbox,
  });
  assert.equal(results.get("npm:lodash@4.17.21")?.ok, true);
  assert.equal(results.get("pip:requests@2.31.0")?.ok, true);
});

test("verify fails when the package is missing or the version mismatches", async () => {
  const envsDir = tempEnvsDir();
  mkdirSync(join(envsDir, "node_modules", "lodash"), { recursive: true });
  writeFileSync(join(envsDir, "node_modules", "lodash", "package.json"), JSON.stringify({ name: "lodash", version: "4.0.0" }));

  const sandbox = fakeSandbox({
    async readFile(path: string) {
      return readFileSync(path, "utf8");
    },
    async readDir(path: string) {
      return readdirSync(path, { withFileTypes: true }).map((entry: { name: string; isDirectory: () => boolean }) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    },
  });

  const results = await installSkillDependenciesSync({
    dependencies: [
      { manager: "npm", name: "lodash", version: "4.17.21" },
      { manager: "pip", name: "missing-pkg", version: "1.0.0" },
    ],
    envsDir,
    sandbox,
  });
  assert.equal(results.get("npm:lodash@4.17.21")?.ok, false, "version mismatch must fail");
  assert.equal(results.get("pip:missing-pkg@1.0.0")?.ok, false, "missing dist-info must fail");
});

test("a failed install command marks the dependency failed with a reason", async () => {
  const envsDir = tempEnvsDir();
  const sandbox = fakeSandbox({
    async exec(): Promise<ExecResult> {
      return { stdout: "", stderr: "npm ERR! 404", exitCode: 1, durationMs: 5, timedOut: false };
    },
  });

  const results = await installSkillDependenciesSync({
    dependencies: [{ manager: "npm", name: "lodash", version: "4.17.21" }],
    envsDir,
    sandbox,
  });
  assert.equal(results.get("npm:lodash@4.17.21")?.ok, false);
  assert.match(results.get("npm:lodash@4.17.21")?.reason ?? "", /install exited with 1/);
});

test("an artifact with no dependencies produces no install results and never runs exec", async () => {
  const envsDir = tempEnvsDir();
  let execCalled = false;
  const sandbox = fakeSandbox({
    async exec(): Promise<ExecResult> {
      execCalled = true;
      throw new Error("exec must not be called for empty dependencies");
    },
  });
  const results = await installSkillDependenciesSync({ dependencies: [], envsDir, sandbox });
  assert.equal(results.size, 0);
  assert.equal(execCalled, false);
});
