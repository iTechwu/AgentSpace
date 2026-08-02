import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { getDaemonSkillInstallEnvsDirPath } from "@dofe-agent/db";
import type { DaemonSkillDependencyEnvironment, TaskSkillExecutionSnapshot } from "@dofe-agent/domain";

const METADATA_FILE = ".dofe-skill-environment.json";

interface SkillDependencyEnvironmentMetadata extends DaemonSkillDependencyEnvironment {
  version: 1;
}

export function buildSkillDependencyTaskEnvironment(input: {
  stateDir: string;
  snapshot?: TaskSkillExecutionSnapshot;
  workspaceId?: string;
  environments?: readonly DaemonSkillDependencyEnvironment[];
  baseEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const environments = input.environments ?? selectSkillDependencyEnvironments(input.snapshot);
  if (environments.length === 0) {
    return {};
  }
  const workspaceId = input.workspaceId ?? input.snapshot?.workspaceId;
  if (!workspaceId) {
    throw new Error("skill_dependency_environment_snapshot_invalid: workspace id is required.");
  }

  const stateRoot = realpathSync(resolve(input.stateDir));
  const envDirs = Array.from(new Set(environments.map((reference) => {
    const envDir = getDaemonSkillInstallEnvsDirPath(input.stateDir, {
      workspaceId,
      installationId: reference.installationId,
    });
    try {
      const stat = lstatSync(envDir);
      const real = realpathSync(envDir);
      const fromStateRoot = relative(stateRoot, real);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fromStateRoot.startsWith("..") || isAbsolute(fromStateRoot)) {
        throw new Error("dependency environment is not a daemon-owned directory");
      }
      if ((stat.mode & 0o222) !== 0) {
        throw new Error("dependency environment is not sealed read-only");
      }
      assertEnvironmentEvidence(real, reference);
      return envDir;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = detail.includes("does not match the frozen task snapshot")
        ? "skill_dependency_environment_mismatch"
        : "skill_dependency_environment_missing";
      throw new Error(
        `${code}: installation "${reference.installationId}" is unavailable: ${detail}`,
      );
    }
  })));

  const source = input.baseEnv ?? process.env;
  return {
    PATH: joinEnv([
      ...envDirs.flatMap((dir) => [join(dir, "node_modules", ".bin"), join(dir, "bin")]),
      source.PATH,
    ]),
    NODE_PATH: joinEnv([...envDirs.map((dir) => join(dir, "node_modules")), source.NODE_PATH]),
    PYTHONPATH: joinEnv([...envDirs, source.PYTHONPATH]),
    PYTHONNOUSERSITE: "1",
  };
}

export function selectSkillDependencyEnvironments(
  snapshot?: TaskSkillExecutionSnapshot,
): DaemonSkillDependencyEnvironment[] {
  return (snapshot?.entries ?? [])
    .filter((entry) => entry.dependencyEnvironmentRequired)
    .map((entry) => {
      if (!entry.releaseLockDigest) {
        throw new Error(
          `skill_dependency_environment_snapshot_invalid: installation "${entry.installationId}" has no release lock digest.`,
        );
      }
      return {
        installationId: entry.installationId,
        artifactDigest: entry.artifactDigest,
        releaseLockDigest: entry.releaseLockDigest,
      };
    });
}

export function publishSkillDependencyEnvironment(input: {
  envsDir: string;
  installationId: string;
  artifactDigest: string;
  releaseLockDigest: string;
}): void {
  const metadata: SkillDependencyEnvironmentMetadata = {
    version: 1,
    installationId: input.installationId,
    artifactDigest: input.artifactDigest,
    releaseLockDigest: input.releaseLockDigest,
  };
  writeFileSync(join(input.envsDir, METADATA_FILE), JSON.stringify(metadata), { mode: 0o600 });
  sealReadOnly(input.envsDir);
}

export function resetSkillDependencyEnvironment(envsDir: string): void {
  if (existsSync(envsDir)) {
    makeDirectoriesWritable(envsDir);
  }
}

function assertEnvironmentEvidence(
  envDir: string,
  reference: DaemonSkillDependencyEnvironment,
): void {
  const metadataPath = join(envDir, METADATA_FILE);
  const stat = lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("dependency environment evidence is not a regular file");
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<SkillDependencyEnvironmentMetadata>;
  if (
    metadata.version !== 1
    || metadata.installationId !== reference.installationId
    || metadata.artifactDigest !== reference.artifactDigest
    || metadata.releaseLockDigest !== reference.releaseLockDigest
  ) {
    throw new Error("dependency environment evidence does not match the frozen task snapshot");
  }
}

function sealReadOnly(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    return;
  }
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) {
      sealReadOnly(join(path, child));
    }
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, entry.mode & 0o111 ? 0o555 : 0o444);
}

function makeDirectoriesWritable(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    return;
  }
  if (!entry.isDirectory()) {
    chmodSync(path, entry.mode & 0o111 ? 0o755 : 0o644);
    return;
  }
  chmodSync(path, 0o755);
  for (const child of readdirSync(path)) {
    makeDirectoriesWritable(join(path, child));
  }
}

function joinEnv(values: Array<string | undefined>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(delimiter);
}
