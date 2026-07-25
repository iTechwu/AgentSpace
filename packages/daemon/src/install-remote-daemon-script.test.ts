import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const installerPath = join(repoRoot, "deploy", "install-remote-daemon.sh");

test("install script readiness hook passes when dofe-agent output and bwrap are compatible", () => {
  const binDir = mkdtempSync(join(tmpdir(), "dofe-agent-install-bin-"));
  try {
    writeExecutable(binDir, "dofe-agent", [
      "#!/bin/sh",
      "if [ \"$1\" = \"output\" ]; then",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    writeExecutable(binDir, "bwrap", [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo bubblewrap 1.0.0",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"--help\" ]; then",
      "  echo 'usage: bwrap --perms MODE PATH'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));

    const result = runReadinessHook(binDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /readiness checks passed/i);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("install script readiness hook fails when dofe-agent output is unavailable", () => {
  const binDir = mkdtempSync(join(tmpdir(), "dofe-agent-install-bin-"));
  try {
    writeExecutable(binDir, "dofe-agent", "#!/bin/sh\nexit 1\n");
    writeCompatibleBwrap(binDir);

    const result = runReadinessHook(binDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dofe-agent output --help failed/i);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("install script readiness hook warns but passes when bwrap does not support --perms", () => {
  const binDir = mkdtempSync(join(tmpdir(), "dofe-agent-install-bin-"));
  try {
    writeDofeAgentOutput(binDir);
    writeExecutable(binDir, "bwrap", [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo bubblewrap 0.9.0",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"--help\" ]; then",
      "  echo 'usage: bwrap'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));

    const result = runReadinessHook(binDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /does not support --perms/i);
    assert.match(result.stdout, /readiness checks passed/i);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("install script prints installed daemon version in bootstrap summary", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-install-version-"));
  const packagePath = join(tempRoot, "dofe-agent-daemon-test.tgz");
  const npmDir = join(tempRoot, "npm-bin");
  const providerBinDir = join(tempRoot, "provider-bin");
  const baseDir = join(tempRoot, "state");
  const installRoot = join(baseDir, "runtime");
  const envFile = join(baseDir, "daemon.env");
  const launcherPath = join(baseDir, "start-daemon.sh");

  try {
    mkdirSync(npmDir, { recursive: true });
    mkdirSync(providerBinDir, { recursive: true });
    writeFileSync(packagePath, "not-a-real-tarball", "utf8");
    writeDofeAgentOutput(providerBinDir);
    writeCompatibleBwrap(providerBinDir);
    writeExecutable(npmDir, "npm", [
      "#!/bin/sh",
      "prefix=''",
      "while [ $# -gt 0 ]; do",
      "  if [ \"$1\" = \"--prefix\" ]; then",
      "    prefix=\"$2\"",
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "mkdir -p \"$prefix/bin\"",
      "cat > \"$prefix/bin/dofe-agent-daemon\" <<'DAEMON'",
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo 9.8.7-test; exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then echo '{\"running\":true}'; exit 0; fi",
      "if [ \"$1\" = \"stop\" ]; then exit 0; fi",
      "if [ \"$1\" = \"start\" ]; then echo 'Remote daemon started (pid 123).'; exit 0; fi",
      "exit 0",
      "DAEMON",
      "chmod +x \"$prefix/bin/dofe-agent-daemon\"",
      "cat > \"$prefix/bin/dofe-agent\" <<'CLI'",
      "#!/bin/sh",
      "if [ \"$1\" = \"output\" ]; then exit 0; fi",
      "exit 1",
      "CLI",
      "chmod +x \"$prefix/bin/dofe-agent\"",
      "exit 0",
      "",
    ].join("\n"));
    // Match BSD install: it does not support GNU's -D flag. The installer
    // already creates parent directories, so plain install must be enough.
    writeExecutable(npmDir, "install", [
      "#!/bin/sh",
      "if [ \"$1\" = \"-D\" ]; then exit 64; fi",
      "mode=''",
      "if [ \"$1\" = \"-m\" ]; then mode=\"$2\"; shift 2; fi",
      "cp \"$1\" \"$2\"",
      "if [ -n \"$mode\" ]; then chmod \"$mode\" \"$2\"; fi",
      "",
    ].join("\n"));

    const result = spawnSync("bash", [
      installerPath,
      "--package", packagePath,
      "--server-url", "https://dofe-agent.example",
      "--daemon-token", "adt_test",
      "--daemon-id", "daemon-test",
      "--base-dir", baseDir,
      "--path", `${providerBinDir}:${process.env.PATH ?? ""}`,
    ], {
      env: {
        ...process.env,
        PATH: `${npmDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed dofe-agent-daemon version: 9\.8\.7-test/);
    assert.match(result.stdout, /Version:\n  9\.8\.7-test/);
    assert.equal(existsSync(envFile), true);
    assert.equal(existsSync(launcherPath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("install script update-existing reinstalls into the existing daemon binary root", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-install-update-root-"));
  const packagePath = join(tempRoot, "dofe-agent-daemon-test.tgz");
  const npmDir = join(tempRoot, "npm-bin");
  const providerBinDir = join(tempRoot, "provider-bin");
  const baseDir = join(tempRoot, "state");
  const existingRoot = join(tempRoot, "existing-runtime");
  const defaultRoot = join(baseDir, "runtime");
  const envFile = join(baseDir, "daemon.env");
  const launcherPath = join(baseDir, "start-daemon.sh");

  try {
    mkdirSync(npmDir, { recursive: true });
    mkdirSync(providerBinDir, { recursive: true });
    mkdirSync(join(existingRoot, "bin"), { recursive: true });
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(packagePath, "not-a-real-tarball", "utf8");
    writeDofeAgentOutput(providerBinDir);
    writeCompatibleBwrap(providerBinDir);
    writeExecutable(join(existingRoot, "bin"), "dofe-agent-daemon", [
      "#!/bin/sh",
      "if [ \"$1\" = \"stop\" ]; then exit 0; fi",
      "exit 0",
      "",
    ].join("\n"));
    writeFileSync(envFile, [
      "DOFE_AGENT_SERVER_URL=https://dofe-agent.example",
      "DOFE_AGENT_DAEMON_TOKEN=adt_existing",
      "DOFE_AGENT_DAEMON_ID=daemon-existing",
      "DOFE_AGENT_DEVICE_NAME=device-existing",
      "DOFE_AGENT_RUNTIME_NAME=Remote\\ Agent",
      `DOFE_AGENT_DAEMON_STATE_DIR=${shellQuote(baseDir)}`,
      `DOFE_AGENT_DAEMON_BIN=${shellQuote(join(existingRoot, "bin", "dofe-agent-daemon"))}`,
      "",
    ].join("\n"), "utf8");
    writeExecutable(npmDir, "npm", [
      "#!/bin/sh",
      "prefix=''",
      "while [ $# -gt 0 ]; do",
      "  if [ \"$1\" = \"--prefix\" ]; then",
      "    prefix=\"$2\"",
      "    shift 2",
      "    continue",
      "  fi",
      "  shift",
      "done",
      "printf '%s\\n' \"$prefix\" > " + shellQuote(join(tempRoot, "npm-prefix.txt")),
      "mkdir -p \"$prefix/bin\"",
      "cat > \"$prefix/bin/dofe-agent-daemon\" <<'DAEMON'",
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo 1.2.3-updated; exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then echo '{\"running\":true}'; exit 0; fi",
      "if [ \"$1\" = \"stop\" ]; then exit 0; fi",
      "if [ \"$1\" = \"start\" ]; then echo 'Remote daemon started (pid 456).'; exit 0; fi",
      "exit 0",
      "DAEMON",
      "chmod +x \"$prefix/bin/dofe-agent-daemon\"",
      "cat > \"$prefix/bin/dofe-agent\" <<'CLI'",
      "#!/bin/sh",
      "if [ \"$1\" = \"output\" ]; then exit 0; fi",
      "exit 1",
      "CLI",
      "chmod +x \"$prefix/bin/dofe-agent\"",
      "exit 0",
      "",
    ].join("\n"));

    const result = spawnSync("bash", [
      installerPath,
      "--update-existing",
      "--package", packagePath,
      "--base-dir", baseDir,
      "--env-file", envFile,
      "--launcher", launcherPath,
      "--path", `${providerBinDir}:${process.env.PATH ?? ""}`,
      "--no-start",
    ], {
      env: {
        ...process.env,
        PATH: `${npmDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readText(join(tempRoot, "npm-prefix.txt")).trim(), existingRoot);
    assert.equal(exists(defaultRoot), false);
    const updatedEnv = readText(envFile);
    assert.match(updatedEnv, new RegExp(`DOFE_AGENT_DAEMON_INSTALL_ROOT=${escapeRegExp(existingRoot)}`));
    assert.match(updatedEnv, new RegExp(`DOFE_AGENT_DAEMON_BIN=${escapeRegExp(join(existingRoot, "bin", "dofe-agent-daemon"))}`));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function runReadinessHook(binDir: string): SpawnSyncReturns<string> {
  return spawnSync("bash", [installerPath], {
    env: {
      ...process.env,
      DOFE_AGENT_INSTALLER_TEST_HOOK: "verify-runtime-readiness",
      DOFE_AGENT_INSTALLER_TEST_PATH: binDir,
    },
    encoding: "utf8",
  });
}

function writeDofeAgentOutput(binDir: string): void {
  writeExecutable(binDir, "dofe-agent", [
    "#!/bin/sh",
    "if [ \"$1\" = \"output\" ]; then",
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n"));
}

function writeCompatibleBwrap(binDir: string): void {
  writeExecutable(binDir, "bwrap", [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then",
    "  echo bubblewrap 1.0.0",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"--help\" ]; then",
    "  echo 'usage: bwrap --perms MODE PATH'",
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n"));
}

function writeExecutable(binDir: string, name: string, contents: string): void {
  const path = join(binDir, name);
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function exists(path: string): boolean {
  return existsSync(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
