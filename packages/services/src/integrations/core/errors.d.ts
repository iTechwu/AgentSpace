import type { ExternalIntegrationProvider } from "@agent-space/db";
export declare class IntegrationProviderError extends Error {
    readonly provider: ExternalIntegrationProvider;
    readonly code: string;
    constructor(input: {
        provider: ExternalIntegrationProvider;
        code: string;
        message: string;
        cause?: unknown;
    });
}
export declare function createIntegrationProviderError(input: {
    provider: ExternalIntegrationProvider;
    code: string;
    message: string;
    cause?: unknown;
}): IntegrationProviderError;
