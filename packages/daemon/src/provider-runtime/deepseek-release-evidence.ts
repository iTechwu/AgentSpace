import {
  DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION,
  DEEPSEEK_JSONRPC_SOURCE_REF,
  DEEPSEEK_JSONRPC_SOURCE_REPOSITORY,
  DEEPSEEK_JSONRPC_WHEEL_DISTRIBUTION,
  DEEPSEEK_JSONRPC_WHEEL_FILENAME,
  DEEPSEEK_JSONRPC_WHEEL_TAG,
  DEEPSEEK_JSONRPC_WHEEL_VERSION,
  verifyDeepSeekJsonRpcPinnedArtifacts,
} from "../agent-router/deepseek-jsonrpc-release.ts";
import { inspectDeepSeekJsonRpcReleaseProtocol } from "./health.ts";
import { resolveDeepSeekJsonRpcReleaseConfig } from "./deepseek-jsonrpc-release.ts";
import type { ProviderRuntimeRecord } from "./types.ts";

export interface DeepSeekJsonRpcReleaseEvidence {
  schemaVersion: 1;
  kind: "deepseek-jsonrpc-release-evidence";
  source: {
    repository: string;
    ref: string;
    commit: string;
  };
  wheel: {
    filename: string;
    sha256: string;
    distribution: string;
    version: string;
    tag: string;
  };
  artifacts: Record<string, string>;
  composition: {
    id: string;
    sha256: string;
  };
  wire: {
    protocol: "jsonrpc-2.0-ndjson";
    protocolVersion: "2.0";
    serverInfo: { name: "deepseek-harness-sdk-runtime"; version: "0.0.1" };
    initialize: true;
    shutdown: true;
    stdoutPurity: true;
  };
}

export function generateDeepSeekJsonRpcReleaseEvidence(): DeepSeekJsonRpcReleaseEvidence {
  const runtime: ProviderRuntimeRecord = {
    id: "deepseek-jsonrpc-release-evidence",
    workspaceId: "release-verification",
    provider: "deepseek-harness",
    name: "DeepSeek Harness release verifier",
    status: "online",
    metadata: {
      executablePath: process.env.DOFE_AGENT_DEEPSEEK_JSONRPC_EXECUTABLE?.trim() ?? "",
      mode: "remote",
      provisioningState: "managed",
    },
  };
  const release = resolveDeepSeekJsonRpcReleaseConfig(runtime);
  if (!release?.provenancePath || !release.sourceCommit || !release.wheelSha256) {
    throw new Error("DeepSeek Harness release evidence requires a complete managed provenance configuration.");
  }
  const verified = verifyDeepSeekJsonRpcPinnedArtifacts(release);
  const protocolFailure = inspectDeepSeekJsonRpcReleaseProtocol(verified, undefined, {
    isolatedEnvironment: true,
  });
  if (protocolFailure) {
    throw new Error("DeepSeek Harness release evidence requires a successful pinned initialize/shutdown handshake.");
  }

  const artifacts: Record<string, string> = {
    "dsh-jsonrpc-agent": release.executableSha256,
    "dsh-jsonrpc-agent-rg": release.ripgrepSha256,
  };
  if (release.spawnHelperSha256) {
    artifacts["dsh-jsonrpc-agent-spawn-helper"] = release.spawnHelperSha256;
  }
  return {
    schemaVersion: 1,
    kind: "deepseek-jsonrpc-release-evidence",
    source: {
      repository: DEEPSEEK_JSONRPC_SOURCE_REPOSITORY,
      ref: DEEPSEEK_JSONRPC_SOURCE_REF,
      commit: release.sourceCommit,
    },
    wheel: {
      filename: DEEPSEEK_JSONRPC_WHEEL_FILENAME,
      sha256: release.wheelSha256,
      distribution: DEEPSEEK_JSONRPC_WHEEL_DISTRIBUTION,
      version: DEEPSEEK_JSONRPC_WHEEL_VERSION,
      tag: DEEPSEEK_JSONRPC_WHEEL_TAG,
    },
    artifacts,
    composition: {
      id: DEEPSEEK_JSONRPC_APPROVED_CORDIS_COMPOSITION,
      sha256: release.cordisConfigSha256,
    },
    wire: {
      protocol: "jsonrpc-2.0-ndjson",
      protocolVersion: "2.0",
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
      initialize: true,
      shutdown: true,
      stdoutPurity: true,
    },
  };
}
