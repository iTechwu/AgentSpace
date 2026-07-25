import type { RuntimeToolCapability } from "@dofe-agent/domain";
import {
  buildFeishuLarkCliRuntimeToolCapability,
  type AgentDocumentContext,
  type FeishuLarkCliResourceGrant,
} from "@dofe-agent/services";

export function buildDocumentRuntimeToolCapabilities(
  agentDocumentContexts: AgentDocumentContext[],
  options?: {
    canCreateGoogleSheet?: boolean;
    feishuLarkCliResourceGrants?: FeishuLarkCliResourceGrant[];
  },
): RuntimeToolCapability[] {
  const hasReadableGoogleWorkspaceDocument = agentDocumentContexts.some(({ document, allowedActions }) =>
    allowedActions.includes("view") &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace",
  );
  const hasWritableGoogleSheet = agentDocumentContexts.some(({ document, allowedActions }) =>
    allowedActions.includes("edit") &&
    document.kind === "sheet" &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace",
  );
  const hasForwardableGoogleSheet = agentDocumentContexts.some(({ document, allowedActions }) =>
    allowedActions.includes("forward") &&
    document.kind === "sheet" &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace",
  );
  const hasWritableGoogleDoc = agentDocumentContexts.some(({ document, allowedActions }) =>
    allowedActions.includes("edit") &&
    document.kind === "document" &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace",
  );
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
        ...(hasReadableGoogleWorkspaceDocument ? ["dofe-agent output sheets-result add *"] : []),
        ...(hasForwardableGoogleSheet ? ["dofe-agent output external-document link-google-sheet *"] : []),
        ...(options?.canCreateGoogleSheet ? ["dofe-agent output external-document create-google-sheet *"] : []),
        ...(hasWritableGoogleDoc ? ["dofe-agent output google-docs *"] : []),
        ...(hasWritableFeishuResource ? ["dofe-agent output feishu data-operation-approval *"] : []),
      ],
      source: "workspace",
    },
  ];

  if (hasReadableGoogleWorkspaceDocument || options?.canCreateGoogleSheet) {
    capabilities.push({
      id: "document-permission:google-workspace",
      command: "gws",
      displayName: "Google Workspace document permission",
      allowedShellPatterns: [
        ...(hasReadableGoogleWorkspaceDocument
          ? [
              "gws sheets spreadsheets values get *",
              "gws drive files get *",
            ]
          : []),
        "gws --version",
        ...(options?.canCreateGoogleSheet ? ["gws drive files create *"] : []),
        ...(hasWritableGoogleSheet
          ? [
              "gws sheets spreadsheets values append *",
              "gws sheets spreadsheets values update *",
              "gws sheets spreadsheets batchUpdate *",
              "gws sheets spreadsheets batch-update *",
            ]
          : []),
      ],
      source: "workspace",
    });
  }

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
