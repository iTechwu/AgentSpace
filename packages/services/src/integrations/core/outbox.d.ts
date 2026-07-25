import { type ExternalMessageOutboxRecord } from "@dofe-agent/db";
import type { ExternalOutboundMessagePayload } from "./message-transport.ts";
import type { IntegrationRuntimeContext } from "./types.ts";
export declare function enqueueExternalOutboundMessageSync(input: {
    context: IntegrationRuntimeContext;
    channelBindingId?: string;
    dofeAgentMessageId?: string;
    outbound: ExternalOutboundMessagePayload;
    metadataJson?: string | Record<string, unknown> | unknown[];
    nextAttemptAt?: string;
}): ExternalMessageOutboxRecord;
export declare function listDueExternalOutboundMessagesSync(input: {
    workspaceId: string;
    integrationId?: string;
    now?: string;
    limit?: number;
}): ExternalMessageOutboxRecord[];
