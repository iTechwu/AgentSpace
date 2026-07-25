import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function buildHostedInstallScript(serverUrl: string): string {
  const template = readFileSync(getInstallScriptTemplatePath(), "utf8");
  return template
    .replace(
      'DEFAULT_SERVER_URL="${DEFAULT_SERVER_URL:-}"',
      `DEFAULT_SERVER_URL=${toShellSingleQuoted(serverUrl)}`,
    )
    .replace(
      'DEFAULT_PACKAGE_URL="${DEFAULT_PACKAGE_URL:-}"',
      `DEFAULT_PACKAGE_URL=${toShellSingleQuoted(`${serverUrl}/api/daemon/package`)}`,
    );
}

export function buildDaemonPackageTarball(): { fileName: string; content: Buffer } {
  const overridePath = process.env.DOFE_AGENT_DAEMON_PACKAGE_PATH?.trim();
  if (overridePath) {
    if (!existsSync(overridePath)) {
      throw new Error(`Configured daemon package override does not exist: ${overridePath}`);
    }
    return {
      fileName: basename(overridePath),
      content: readFileSync(overridePath),
    };
  }

  const packageDir = getDaemonPackageDirectory();
  const packDestination = join("/tmp", "dofe-agent-daemon-dist");
  const npmCacheDir = join("/tmp", "dofe-agent-npm-cache");
  mkdirSync(packDestination, { recursive: true });
  mkdirSync(npmCacheDir, { recursive: true });

  const result = spawnSync(
    "npm",
    ["pack", "--pack-destination", packDestination],
    {
      cwd: packageDir,
      env: { ...process.env, npm_config_cache: npmCacheDir },
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    throw new Error(stderr || `npm pack failed with exit code ${result.status ?? "unknown"}.`);
  }

  const fileName = `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!fileName) {
    throw new Error("npm pack did not return a tarball filename.");
  }

  const tarballPath = join(packDestination, fileName);
  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball does not exist: ${tarballPath}`);
  }

  const content = readFileSync(tarballPath);
  rmSync(tarballPath, { force: true });
  return { fileName, content };
}

export function resolveRequestOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}

function getInstallScriptTemplatePath(): string {
  return join(resolveRepositoryRoot(), "deploy", "install-remote-daemon.sh");
}

function getDaemonPackageDirectory(): string {
  return join(resolveRepositoryRoot(), "packages", "daemon");
}

function resolveRepositoryRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "../../../../../../");
}

function toShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
