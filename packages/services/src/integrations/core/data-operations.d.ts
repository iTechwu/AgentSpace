import { type ExternalDataOperationRunStatus, type ExternalDataOperationRunRecord } from "@dofe-agent/db";
import type { ExternalDataOperationRequest, ExternalDataOperationResult, IntegrationRuntimeContext } from "./types.ts";
export declare function recordExternalDataOperationStartSync(input: {
    context: IntegrationRuntimeContext;
    resourceBindingId?: string;
    request: ExternalDataOperationRequest;
}): ExternalDataOperationRunRecord;
export declare function recordExternalDataOperationPlanSync(input: {
    context: IntegrationRuntimeContext;
    resourceBindingId?: string;
    request: ExternalDataOperationRequest;
    requestJson?: Record<string, unknown>;
    status?: ExternalDataOperationRunStatus;
}): ExternalDataOperationRunRecord;
export declare function recordExternalDataOperationFinishSync(input: {
    workspaceId: string;
    runId: string;
    result: ExternalDataOperationResult;
}): ExternalDataOperationRunRecord;
