import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export const DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION = "dsh-v0.1.1-rc.2-default";
export const DEEPSEEK_JSONRPC_APPROVED_CORDIS_SHA256 = "048031be7331f2b68c81b3cbfacacc06ee767dae1e8f00cbdc3137c1e55001af";
export const DEEPSEEK_JSONRPC_SOURCE_REPOSITORY = "https://github.com/iTechwu/deepseek-harness";
export const DEEPSEEK_JSONRPC_SOURCE_REF = "dsh-v0.1.1-rc.2";
export const DEEPSEEK_JSONRPC_SOURCE_COMMIT = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
export const DEEPSEEK_JSONRPC_WHEEL_FILENAME = "deepseek_harness_runtime_bin-0.1.1rc2-py3-none-manylinux_2_28_x86_64.whl";
export const DEEPSEEK_JSONRPC_WHEEL_DISTRIBUTION = "deepseek-harness-runtime-bin";
export const DEEPSEEK_JSONRPC_WHEEL_VERSION = "0.1.1rc2";
export const DEEPSEEK_JSONRPC_WHEEL_TAG = "py3-none-manylinux_2_28_x86_64";

export interface DeepSeekJsonRpcPinnedArtifacts {
  executablePath: string;
  executableSha256: string;
  cordisConfigPath: string;
  cordisConfigSha256: string;
  ripgrepSha256: string;
  spawnHelperSha256?: string;
  provenancePath?: string;
  sourceCommit?: string;
  wheelSha256?: string;
}

const UNSAFE_RELEASE_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "ZDOTDIR",
  "_JAVA_OPTIONS",
]);

export function verifyDeepSeekJsonRpcPinnedArtifacts(
  artifacts: DeepSeekJsonRpcPinnedArtifacts,
): {
  executablePath: string;
  cordisConfigPath: string;
  ripgrepPath: string;
  spawnHelperPath?: string;
  provenancePath?: string;
} {
  const executablePath = verifyPinnedFile(
    artifacts.executablePath,
    artifacts.executableSha256,
    "runtime executable",
    true,
    true,
  );
  const ripgrepPath = verifyPinnedFile(
    `${executablePath}-rg`,
    artifacts.ripgrepSha256,
    "ripgrep sidecar",
    false,
    true,
  );
  const spawnHelperPath = process.platform === "darwin"
    ? verifyPinnedFile(
        `${executablePath}-spawn-helper`,
        artifacts.spawnHelperSha256 ?? "",
        "node-pty spawn helper sidecar",
        false,
        true,
      )
    : undefined;
  const cordisConfigPath = verifyPinnedFile(
    artifacts.cordisConfigPath,
    artifacts.cordisConfigSha256,
    "Cordis config",
    false,
    false,
  );
  if (artifacts.cordisConfigSha256.trim().toLowerCase() !== DEEPSEEK_JSONRPC_APPROVED_CORDIS_SHA256) {
    throw new Error(
      `DeepSeek Harness JSON-RPC Cordis config was not the approved ${DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION} composition.`,
    );
  }
  const provenancePath = verifyManagedProvenance(artifacts, executablePath);
  return {
    executablePath,
    cordisConfigPath,
    ripgrepPath,
    spawnHelperPath,
    provenancePath,
  };
}

function verifyManagedProvenance(
  artifacts: DeepSeekJsonRpcPinnedArtifacts,
  executablePath: string,
): string | undefined {
  const values = [artifacts.provenancePath, artifacts.sourceCommit, artifacts.wheelSha256];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance pins were incomplete.");
  }
  const sourceCommit = artifacts.sourceCommit?.trim().toLowerCase() ?? "";
  const wheelSha256 = artifacts.wheelSha256?.trim().toLowerCase() ?? "";
  if (sourceCommit !== DEEPSEEK_JSONRPC_SOURCE_COMMIT) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance source commit mismatch.");
  }
  if (!/^[a-f0-9]{64}$/.test(wheelSha256)) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance wheel pin was not a valid SHA-256 digest.");
  }

  const { canonicalPath, bytes } = readRegularFile(artifacts.provenancePath ?? "", "managed provenance");
  if (dirname(canonicalPath) !== dirname(executablePath)) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance must be adjacent to the runtime executable.");
  }
  if (bytes.length > 64 * 1024) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance exceeded the maximum size.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance was not valid JSON.");
  }
  const root = exactRecord(parsed, ["schemaVersion", "source", "wheel", "artifacts"]);
  const source = exactRecord(root?.source, ["repository", "ref", "commit"]);
  const wheel = exactRecord(root?.wheel, ["filename", "sha256", "distribution", "version", "tag"]);
  const provenanceArtifacts = exactRecord(root?.artifacts, ["dsh-jsonrpc-agent", "dsh-jsonrpc-agent-rg"]);
  const executable = exactRecord(provenanceArtifacts?.["dsh-jsonrpc-agent"], ["source", "sha256"]);
  const ripgrep = exactRecord(provenanceArtifacts?.["dsh-jsonrpc-agent-rg"], ["source", "sha256"]);
  const valid = root?.schemaVersion === 1
    && source?.repository === DEEPSEEK_JSONRPC_SOURCE_REPOSITORY
    && source.ref === DEEPSEEK_JSONRPC_SOURCE_REF
    && source.commit === sourceCommit
    && wheel?.filename === DEEPSEEK_JSONRPC_WHEEL_FILENAME
    && wheel.sha256 === wheelSha256
    && wheel.distribution === DEEPSEEK_JSONRPC_WHEEL_DISTRIBUTION
    && wheel.version === DEEPSEEK_JSONRPC_WHEEL_VERSION
    && wheel.tag === DEEPSEEK_JSONRPC_WHEEL_TAG
    && executable?.source === "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64"
    && executable.sha256 === artifacts.executableSha256.trim().toLowerCase()
    && ripgrep?.source === "deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-pkg-linux-x64-rg"
    && ripgrep.sha256 === artifacts.ripgrepSha256.trim().toLowerCase();
  if (!valid) {
    throw new Error("DeepSeek Harness JSON-RPC managed provenance did not match the pinned runtime release.");
  }
  return canonicalPath;
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    ? record
    : undefined;
}

export function stripDeepSeekJsonRpcUnsafeEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    if (UNSAFE_RELEASE_ENVIRONMENT_KEYS.has(normalizedKey) || normalizedKey.startsWith("DYLD_")) continue;
    if (normalizedKey === "PATH") {
      sanitized.PATH = value;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function verifyPinnedFile(
  path: string,
  expectedSha256: string,
  label: string,
  requireFixedInterpreter: boolean,
  requireExecutable: boolean,
): string {
  const expected = expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`DeepSeek Harness JSON-RPC ${label} pin was not a valid SHA-256 digest.`);
  }
  const { canonicalPath, stat, bytes } = readRegularFile(path, label);
  if (requireExecutable && process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    throw new Error(`DeepSeek Harness JSON-RPC ${label} was not executable: ${canonicalPath}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`DeepSeek Harness JSON-RPC ${label} SHA-256 digest mismatch.`);
  }
  if (requireFixedInterpreter) assertFixedInterpreter(bytes, canonicalPath);
  return canonicalPath;
}

function readRegularFile(
  path: string,
  label: string,
): { canonicalPath: string; stat: Stats; bytes: Buffer } {
  let canonicalPath: string;
  let stat: Stats;
  try {
    canonicalPath = realpathSync(path);
    stat = statSync(canonicalPath);
  } catch {
    throw new Error(`DeepSeek Harness JSON-RPC ${label} was not a regular file: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`DeepSeek Harness JSON-RPC ${label} was not a regular file: ${canonicalPath}`);
  }
  return { canonicalPath, stat, bytes: readFileSync(canonicalPath) };
}

function assertFixedInterpreter(bytes: Buffer, executablePath: string): void {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return;
  const firstLine = bytes.subarray(2, Math.min(bytes.length, 4_096)).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const interpreter = firstLine.split(/\s+/, 1)[0] ?? "";
  if (!isAbsolute(interpreter) || basename(interpreter) === "env") {
    throw new Error(
      `DeepSeek Harness JSON-RPC runtime executable must use a fixed absolute interpreter, not an environment-resolved shebang: ${executablePath}`,
    );
  }
}
