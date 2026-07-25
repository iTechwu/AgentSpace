import type { ExternalIntegrationProvider } from "@dofe-agent/db";
import type { ExternalDocumentProviderAdapter } from "./document-provider.ts";
import type { MessageTransportAdapter } from "./message-transport.ts";
import type { IntegrationHealth, IntegrationProviderDescriptor, IntegrationRuntimeContext } from "./types.ts";
export interface IntegrationProviderAdapter {
    descriptor: IntegrationProviderDescriptor;
    messageTransport?: MessageTransportAdapter;
    documentProvider?: ExternalDocumentProviderAdapter;
    checkHealth?: (context: IntegrationRuntimeContext) => Promise<IntegrationHealth> | IntegrationHealth;
}
export declare function registerIntegrationProviderAdapter(adapter: IntegrationProviderAdapter): void;
export declare function readIntegrationProviderAdapter(provider: ExternalIntegrationProvider): IntegrationProviderAdapter | null;
export declare function listIntegrationProviderAdapters(): IntegrationProviderAdapter[];
export declare function clearIntegrationProviderAdaptersForTests(): void;
