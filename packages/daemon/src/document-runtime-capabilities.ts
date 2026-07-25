import type { RuntimeToolCapability } from "@dofe-agent/domain";
import {
  buildFeishuLarkCliRuntimeToolCapability,
  type AgentDocumentContext,
  type FeishuLarkCliResourceGrant,
} from "@dofe-agent/services";

export function buildDocumentRuntimeToolCapabilities(
  agentDocumentContexts: AgentDocumentContext[],
  options?: {
    feishuLarkCliResourceGrants?: FeishuLarkCliResourceGrant[];
  },
): RuntimeToolCapability[] {
  const hasEditableDocument = agentDocumentContexts.some(({ allowedActions }) => allowedActions.includes("edit"));
  const hasWritableFeishuResource = options?.feishuLarkCliResourceGrants?.some((grant) =>
    grant.allowedOperations?.includes("write")
  ) ?? false;

  const capabilities: RuntimeToolCapability[] = [
    {
      id: "document-permission:dofe-agent-output",
      command: "dofe-agent",
      displayName: "DofeAgent document output permission",
      allowedShellPatterns: [
        "dofe-agent output text *",
        "dofe-agent output attach *",
        "dofe-agent output validate *",
        "dofe-agent output preview *",
        "dofe-agent output permission request-document *",
        ...(hasEditableDocument
          ? [
              "dofe-agent output document upsert *",
              "dofe-agent output document replace-block *",
              "dofe-agent output document insert-after *",
              "dofe-agent output document delete-block *",
            ]
          : []),
        ...(hasWritableFeishuResource ? ["dofe-agent output feishu data-operation-approval *"] : []),
      ],
      source: "workspace",
    },
  ];

  const feishuLarkCliCapability = buildFeishuLarkCliRuntimeToolCapability({
    id: "document-permission:feishu-lark-cli",
    source: "workspace",
    includeDiagnostics: Boolean(options?.feishuLarkCliResourceGrants?.length),
    resourceGrants: options?.feishuLarkCliResourceGrants ?? [],
  });
  if (feishuLarkCliCapability) {
    capabilities.push(feishuLarkCliCapability);
  }

  return capabilities;
}
