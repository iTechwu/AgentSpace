import {
  createExternalMessageOutboxSync,
  listPendingExternalMessageOutboxSync,
  type ExternalMessageOutboxRecord,
} from "@dofe-agent/db";
import type { ExternalOutboundMessagePayload } from "./message-transport.ts";
import type { IntegrationRuntimeContext } from "./types.ts";

export function enqueueExternalOutboundMessageSync(input: {
  context: IntegrationRuntimeContext;
  channelBindingId?: string;
  dofeAgentMessageId?: string;
  outbound: ExternalOutboundMessagePayload;
  metadataJson?: string | Record<string, unknown> | unknown[];
  nextAttemptAt?: string;
}): ExternalMessageOutboxRecord {
  return createExternalMessageOutboxSync({
    workspaceId: input.context.workspaceId,
    integrationId: input.context.integrationId,
    channelBindingId: input.channelBindingId,
    targetExternalChatId: input.outbound.targetExternalChatId,
    targetExternalThreadId: input.outbound.targetExternalThreadId,
    dofeAgentMessageId: input.dofeAgentMessageId,
    payloadJson: input.outbound.payload,
    metadataJson: input.metadataJson,
    nextAttemptAt: input.nextAttemptAt,
  });
}

export function listDueExternalOutboundMessagesSync(input: {
  workspaceId: string;
  integrationId?: string;
  now?: string;
  limit?: number;
}): ExternalMessageOutboxRecord[] {
  return listPendingExternalMessageOutboxSync(input);
}
