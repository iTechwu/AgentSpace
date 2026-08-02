import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type {
  ClaimedSkillInstallationOperation,
  SkillComponentKind,
  SkillComponentStatus,
} from "@dofe-agent/domain";
import type { SkillArtifactManifest } from "@dofe-agent/services";

export interface ComponentVerificationResult {
  kind: SkillComponentKind;
  key: string;
  status: SkillComponentStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface DependencyInstallOutcome {
  ok: boolean;
  reason?: string;
}

const SYNTAX_CHECK_TIMEOUT_MS = 10_000;
const MAX_TAIL_CHARS = 2_000;

const SECRET_PATTERNS = [
  /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"',;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

/**
 * Verifies every component declared in the claimed operation against the
 * materialized artifact directory. Integrity failures are surfaced as
 * component failures so the control plane can block the installation.
 */
export function verifySkillInstallationComponents(
  operation: ClaimedSkillInstallationOperation,
  artifactDir: string,
  rootDigestMatches: boolean,
  dependencyInstallResults?: Map<string, DependencyInstallOutcome>,
): ComponentVerificationResult[] {
  if (!rootDigestMatches) {
    return operation.components.map((component) => ({
      kind: component.kind,
      key: component.key,
      status: "failed",
      errorCode: "skill_installation.root_digest_mismatch",
      errorMessage: "Artifact root digest does not match the claimed digest; refusing to verify components.",
    }));
  }

  let manifest: SkillArtifactManifest;
  try {
    manifest = JSON.parse(operation.manifestJson) as SkillArtifactManifest;
  } catch {
    return operation.components.map((component) => ({
      kind: component.kind,
      key: component.key,
      status: "failed",
      errorCode: "skill_installation.invalid_manifest_json",
      errorMessage: "Artifact manifest JSON is invalid; cannot verify components.",
    }));
  }

  return operation.components.map((component) =>
    verifyComponent(component.kind, component.key, manifest, artifactDir, dependencyInstallResults));
}

function verifyComponent(
  kind: SkillComponentKind,
  key: string,
  manifest: SkillArtifactManifest,
  artifactDir: string,
  dependencyInstallResults?: Map<string, DependencyInstallOutcome>,
): ComponentVerificationResult {
  switch (kind) {
    case "dependency":
      return verifyDependencyComponent(key, manifest, dependencyInstallResults);
    case "script":
      return verifyScriptComponent(key, manifest, artifactDir);
    case "cli":
    case "mcp":
      return verifyCapabilityComponent(kind, key, manifest);
    case "service":
      // Services are control-plane-decided: the daemon cannot verify a managed
      // service container, so it reports `pending` and the control plane overrides
      // the component from the skill_service_binding state on completion.
      return {
        kind,
        key,
        status: "pending",
        errorCode: "skill_installation.service_control_plane_decided",
        errorMessage: "Service readiness is decided by the control plane from the service binding state.",
      };
    default:
      return {
        kind,
        key,
        status: "failed",
        errorCode: "skill_installation.unknown_component_kind",
        errorMessage: `Unknown component kind: ${kind}`,
      };
  }
}

function verifyDependencyComponent(
  key: string,
  manifest: SkillArtifactManifest,
  dependencyInstallResults?: Map<string, DependencyInstallOutcome>,
): ComponentVerificationResult {
  if (key === "package:integrity") {
    return { kind: "dependency", key, status: "ready" };
  }
  const source = key.split(":", 1)[0];
  if (source !== "npm" && source !== "pip" && source !== "uv") {
    return {
      kind: "dependency",
      key,
      status: "blocked",
      errorCode: "skill_installation.dependency_manager_unsupported",
      errorMessage: `Dependency manager "${source}" requires a managed Runtime catalog resolver.`,
    };
  }
  // When the daemon actually installed + verified dependencies, the install
  // outcome is the source of truth: ready only after a real install+verify.
  if (dependencyInstallResults) {
    const outcome = dependencyInstallResults.get(key);
    if (!outcome) {
      return {
        kind: "dependency",
        key,
        status: "blocked",
        errorCode: "skill_installation.dependency_not_installed",
        errorMessage: `Dependency "${key}" was not installed on this runtime.`,
      };
    }
    if (!outcome.ok) {
      return {
        kind: "dependency",
        key,
        status: "failed",
        errorCode: "skill_installation.dependency_install_failed",
        errorMessage: outcome.reason ?? `Dependency "${key}" install verification failed.`,
      };
    }
    return { kind: "dependency", key, status: "ready" };
  }
  const declared = (manifest.dependencies ?? []).find((dep) =>
    `${getDependencySource(dep)}:${dep.name}@${dep.version}` === key);
  if (!declared) {
    return {
      kind: "dependency",
      key,
      status: "failed",
      errorCode: "skill_installation.dependency_not_declared",
      errorMessage: `Dependency "${key}" is not declared in the artifact manifest.`,
    };
  }
  if (!declared.version) {
    return {
      kind: "dependency",
      key,
      status: "blocked",
      errorCode: "skill_installation.dependency_version_missing",
      errorMessage: `Dependency "${key}" is missing a locked version.`,
    };
  }
  return { kind: "dependency", key, status: "ready" };
}

function getDependencySource(dep: SkillArtifactManifest["dependencies"][number]): string {
  return (dep as { manager?: string; kind?: string }).manager ??
    (dep as { manager?: string; kind?: string }).kind ??
    "";
}

function verifyScriptComponent(
  key: string,
  manifest: SkillArtifactManifest,
  artifactDir: string,
): ComponentVerificationResult {
  const manifestFile = manifest.files.find((file) => file.path === key);
  if (!manifestFile) {
    return {
      kind: "script",
      key,
      status: "failed",
      errorCode: "skill_installation.script_not_in_manifest",
      errorMessage: `Script "${key}" is not listed in the artifact manifest.`,
    };
  }
  if (manifestFile.mode !== "0755") {
    return {
      kind: "script",
      key,
      status: "blocked",
      errorCode: "skill_installation.script_not_executable",
      errorMessage: `Script "${key}" mode is ${manifestFile.mode}, expected 0755.`,
    };
  }

  const filePath = resolve(artifactDir, key);
  if (!existsSync(filePath)) {
    return {
      kind: "script",
      key,
      status: "failed",
      errorCode: "skill_installation.script_missing",
      errorMessage: `Script "${key}" was not materialized.`,
    };
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return {
      kind: "script",
      key,
      status: "failed",
      errorCode: "skill_installation.script_not_file",
      errorMessage: `Script "${key}" is not a regular file.`,
    };
  }

  if ((stat.mode & 0o111) === 0) {
    return {
      kind: "script",
      key,
      status: "blocked",
      errorCode: "skill_installation.script_not_executable",
      errorMessage: `Script "${key}" does not have an executable bit after materialization.`,
    };
  }

  const interpreter = chooseInterpreter(key);
  if (interpreter) {
    const syntaxResult = runSyntaxCheck(filePath, interpreter);
    if (!syntaxResult.ok) {
      return {
        kind: "script",
        key,
        status: "blocked",
        errorCode: "skill_installation.script_syntax_error",
        errorMessage: `Script "${key}" syntax check failed: ${syntaxResult.error}`,
      };
    }
  }

  return { kind: "script", key, status: "ready" };
}

function verifyCapabilityComponent(
  kind: "cli" | "mcp",
  key: string,
  manifest: SkillArtifactManifest,
): ComponentVerificationResult {
  const slug = key.slice(kind.length + 1);
  const declared = (manifest.capabilities ?? []).find(
    (cap) => (cap.kind === "cli" ? "cli" : "mcp") === kind && cap.catalogSlug === slug,
  );
  if (!declared) {
    return {
      kind,
      key,
      status: "failed",
      errorCode: "skill_installation.capability_not_declared",
      errorMessage: `${kind.toUpperCase()} capability "${slug}" is not declared in the artifact manifest.`,
    };
  }
  return { kind, key, status: "ready" };
}

function chooseInterpreter(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const ext = extname(lower);
  if (ext === ".sh") return "sh";
  if (ext === ".js" || ext === ".mjs") return "node";
  if (ext === ".ts" || ext === ".mts") return "node";
  if (ext === ".py") return "python";
  return null;
}

function runSyntaxCheck(filePath: string, interpreter: string): { ok: true } | { ok: false; error: string } {
  const args = syntaxCheckArgs(interpreter, filePath);
  if (!args) {
    return { ok: true };
  }

  const result = spawnSync(args[0], args.slice(1), {
    env: process.env,
    encoding: "utf8",
    timeout: SYNTAX_CHECK_TIMEOUT_MS,
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const output = tailAndRedact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return { ok: false, error: output || `exited with code ${result.status}` };
  }
  return { ok: true };
}

function syntaxCheckArgs(interpreter: string, filePath: string): string[] | null {
  switch (interpreter) {
    case "sh":
      return ["sh", "-n", filePath];
    case "node":
      return ["node", "--check", filePath];
    case "python":
      return ["python", "-m", "py_compile", filePath];
    default:
      return null;
  }
}

function tailAndRedact(value: string): string {
  let output = value.slice(-MAX_TAIL_CHARS);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string, separator?: string) =>
      separator ? `${prefix}${separator}[REDACTED]` : `${prefix}[REDACTED]`,
    );
  }
  return output.trim() || "(no output)";
}
