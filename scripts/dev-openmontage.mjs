import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoDir = resolve(scriptDir, "..");

export function loadOpenMontageDevEnvironment(options = {}) {
  const repoDir = resolve(options.repoDir ?? defaultRepoDir);
  const baseEnvironment = options.baseEnvironment ?? process.env;
  const agentEnvironment = readEnvironmentFile(resolve(repoDir, ".env"), false);
  const openMontageEnvironmentFile = baseEnvironment.OPENMONTAGE_ENV_FILE?.trim()
    ? resolve(repoDir, baseEnvironment.OPENMONTAGE_ENV_FILE.trim())
    : resolve(repoDir, "..", "OpenMontage", ".env");
  const openMontageEnvironment = readEnvironmentFile(openMontageEnvironmentFile, true);

  const serviceToken = firstValue(
    baseEnvironment.OPENMONTAGE_SERVICE_TOKEN,
    agentEnvironment.OPENMONTAGE_SERVICE_TOKEN,
    openMontageEnvironment.OPENMONTAGE_SERVICE_TOKEN,
  );
  const eventSigningSecret = firstValue(
    baseEnvironment.OPENMONTAGE_EVENT_SIGNING_SECRET,
    agentEnvironment.OPENMONTAGE_EVENT_SIGNING_SECRET,
    openMontageEnvironment.OPENMONTAGE_EVENT_SIGNING_SECRET,
  );
  assertSecret("OPENMONTAGE_SERVICE_TOKEN", serviceToken);
  assertSecret("OPENMONTAGE_EVENT_SIGNING_SECRET", eventSigningSecret);

  const configuredVaultDir = firstValue(
    baseEnvironment.DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR,
    agentEnvironment.DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR,
  );
  const vaultDir = configuredVaultDir
    ? (isAbsolute(configuredVaultDir) ? configuredVaultDir : resolve(repoDir, configuredVaultDir))
    : resolve(repoDir, "data", "runtime-credential-vault");

  return {
    ...baseEnvironment,
    OPENMONTAGE_BASE_URL: firstValue(
      baseEnvironment.OPENMONTAGE_BASE_URL,
      agentEnvironment.OPENMONTAGE_BASE_URL,
    ) ?? "http://127.0.0.1:8765",
    OPENMONTAGE_SERVICE_TOKEN: serviceToken,
    OPENMONTAGE_EVENT_SIGNING_SECRET: eventSigningSecret,
    DOFE_AGENT_RUNTIME_CREDENTIAL_VAULT_DIR: vaultDir,
  };
}

function readEnvironmentFile(path, required) {
  if (!existsSync(path)) {
    if (required) throw new Error(`OpenMontage environment file does not exist: ${path}`);
    return {};
  }
  return parseEnv(readFileSync(path, "utf8"));
}

function firstValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function assertSecret(name, value) {
  if (!value || value.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters.`);
  }
}

async function main() {
  const environment = loadOpenMontageDevEnvironment();
  if (process.argv.includes("--check")) {
    console.log("OpenMontage development configuration is ready.");
    return;
  }

  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "dev"], {
    cwd: defaultRepoDir,
    env: environment,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
