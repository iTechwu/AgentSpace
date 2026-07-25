import type { ExternalResourceBindingProviderType, ExternalResourceBindingRecord } from "@dofe-agent/db";
import type { RuntimeToolCapability } from "@dofe-agent/domain";
import type { ExternalDataOperationRequest, ExternalDataOperationResult } from "../../core/index.ts";
import { FEISHU_PROVIDER_ID } from "./constants.ts";
export declare const DEFAULT_FEISHU_LARK_CLI_COMMAND = "lark-cli";
export declare const FEISHU_LARK_CLI_EXECUTOR_ENV_NAMES: readonly ["DOFE_AGENT_FEISHU_LARK_CLI_EXECUTOR", "DOFE_AGENT_LARK_CLI_EXECUTOR"];
export declare const FEISHU_LARK_CLI_OPERATION_MANIFEST_KIND = "dofe-agent.feishu.lark-cli.operation";
export declare const FEISHU_LARK_CLI_RESULT_MANIFEST_KIND = "dofe-agent.feishu.lark-cli.result";
export declare const FEISHU_LARK_CLI_MANIFEST_SCHEMA_VERSION = 1;
export declare const FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH = "runtime-output/feishu-data-operation-result.json";
export type FeishuLarkCliOperationKind = "read" | "write";
export interface FeishuLarkCliResourceGrant {
    integrationId?: string;
    resourceBindingId?: string;
    providerResourceType: ExternalResourceBindingProviderType;
    providerResourceToken: string;
    providerResourceUrl?: string;
    baseToken?: string;
    tableId?: string;
    viewId?: string;
    allowedOperations?: FeishuLarkCliOperationKind[];
}
export interface BuildFeishuLarkCliRuntimeToolCapabilityInput {
    command?: string;
    id?: string;
    displayName?: string;
    source?: RuntimeToolCapability["source"];
    resourceGrants?: FeishuLarkCliResourceGrant[];
    includeDiagnostics?: boolean;
    env?: Record<string, string>;
}
export interface FeishuLarkCliOperationManifestResourceGrant {
    providerResourceType: ExternalResourceBindingProviderType;
    providerResourceToken: string;
    providerResourceUrl?: string;
    baseToken?: string;
    tableId?: string;
    viewId?: string;
    allowedOperations: FeishuLarkCliOperationKind[];
}
export interface FeishuLarkCliOperationManifest {
    kind: typeof FEISHU_LARK_CLI_OPERATION_MANIFEST_KIND;
    schemaVersion: typeof FEISHU_LARK_CLI_MANIFEST_SCHEMA_VERSION;
    provider: typeof FEISHU_PROVIDER_ID;
    operationRunId: string;
    operationType: string;
    operationKind: FeishuLarkCliOperationKind;
    payloadHash?: string;
    expiresAt: string;
    command: string;
    resultManifestPath: string;
    resourceGrant: FeishuLarkCliOperationManifestResourceGrant;
    allowedShellPatterns: string[];
    allowedResourceTokens: string[];
    requestSummary?: Record<string, unknown>;
    constraints: {
        noLongLivedCredentials: true;
        requiresPayloadHashForWrite: true;
    };
}
export interface BuildFeishuLarkCliOperationManifestInput {
    operationRunId: string;
    request: ExternalDataOperationRequest;
    resourceGrant: FeishuLarkCliResourceGrant;
    payloadHash?: string;
    expiresAt?: string;
    command?: string;
    resultManifestPath?: string;
    requestSummary?: Record<string, unknown>;
}
export type FeishuLarkCliRuntimeReadinessStatus = "disabled" | "available" | "blocked" | "unavailable";
export interface FeishuLarkCliRuntimeDiagnostic {
    status: FeishuLarkCliRuntimeReadinessStatus;
    reasonCode: string;
    message: string;
    command?: string;
    capability?: RuntimeToolCapability;
}
export interface DiagnoseFeishuLarkCliRuntimeInput {
    environment?: Record<string, string | undefined>;
    commandExists?: (command: string) => boolean;
    source?: RuntimeToolCapability["source"];
    resourceGrants?: FeishuLarkCliResourceGrant[];
    includeDiagnostics?: boolean;
}
export declare function resolveFeishuLarkCliCommand(environment?: Record<string, string | undefined>): string;
export declare function diagnoseFeishuLarkCliRuntime(input?: DiagnoseFeishuLarkCliRuntimeInput): FeishuLarkCliRuntimeDiagnostic;
export declare function resolveFeishuLarkCliOperationKind(operationType: string): FeishuLarkCliOperationKind;
export declare function buildFeishuLarkCliOperationManifest(input: BuildFeishuLarkCliOperationManifestInput): FeishuLarkCliOperationManifest | undefined;
export declare function summarizeFeishuLarkCliResultManifest(value: unknown): ExternalDataOperationResult;
export declare function isFeishuLarkCliRuntimeEnabled(environment?: Record<string, string | undefined>): boolean;
export declare function buildFeishuLarkCliDiagnosticRuntimeToolCapability(input?: {
    environment?: Record<string, string | undefined>;
    source?: RuntimeToolCapability["source"];
}): RuntimeToolCapability | undefined;
export declare function buildFeishuLarkCliRuntimeToolCapability(input?: BuildFeishuLarkCliRuntimeToolCapabilityInput): RuntimeToolCapability | undefined;
export declare function buildFeishuLarkCliAllowedShellPatterns(input?: {
    command?: string;
    resourceGrants?: FeishuLarkCliResourceGrant[];
    includeDiagnostics?: boolean;
    includeWritePatterns?: boolean;
}): string[];
export declare function listFeishuLarkCliResourceGrantsForChannelSync(input: {
    workspaceId: string;
    channelName?: string;
}): FeishuLarkCliResourceGrant[];
export declare function buildFeishuLarkCliResourceGrantFromBinding(binding: ExternalResourceBindingRecord): FeishuLarkCliResourceGrant | null;
