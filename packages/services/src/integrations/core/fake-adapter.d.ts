import type { IntegrationProviderAdapter } from "./registry.ts";
export declare const FAKE_INTEGRATION_PROVIDER_ID = "fake";
export interface FakeIntegrationProviderAdapterOptions {
    now?: () => string;
    onHealthCheck?: () => void;
}
export declare function createFakeIntegrationProviderAdapter(options?: FakeIntegrationProviderAdapterOptions): IntegrationProviderAdapter;
