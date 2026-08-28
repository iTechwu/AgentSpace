import type { ExternalResourceOperationDescriptor } from "../../core/index.ts";

/**
 * Static catalogue of Feishu data-plane operations. Lives in its own module so
 * data-plane.ts and operation-plan.ts can both depend on it without forming a
 * data-plane ↔ operation-plan import cycle (operation-plan resolves descriptors
 * while data-plane re-exports them).
 */
export const FEISHU_DATA_OPERATION_DESCRIPTORS: ExternalResourceOperationDescriptor[] = [
  {
    operationType: "docs.read_document",
    providerResourceTypes: ["doc"],
    description: "Read a Feishu Docs document.",
    writeOperation: false,
  },
  {
    operationType: "docs.refresh_metadata",
    providerResourceTypes: ["doc"],
    description: "Refresh Feishu Docs document metadata.",
    writeOperation: false,
  },
  {
    operationType: "docs.create_document",
    providerResourceTypes: ["doc"],
    description: "Create a Feishu Docs document through an approved DofeAgent operation.",
    writeOperation: true,
  },
  {
    operationType: "docs.update_document",
    providerResourceTypes: ["doc"],
    description: "Update a Feishu Docs document through an approved DofeAgent operation.",
    writeOperation: true,
  },
  {
    operationType: "sheets.read_range",
    providerResourceTypes: ["sheet"],
    description: "Read a Feishu Sheets range.",
    writeOperation: false,
  },
  {
    operationType: "sheets.refresh_metadata",
    providerResourceTypes: ["sheet"],
    description: "Refresh Feishu Sheets spreadsheet metadata.",
    writeOperation: false,
  },
  {
    operationType: "sheets.update_range",
    providerResourceTypes: ["sheet"],
    description: "Update a Feishu Sheets range through an approved DofeAgent operation.",
    writeOperation: true,
  },
  {
    operationType: "base.query_records",
    providerResourceTypes: ["base", "base_table", "base_view"],
    description: "Query Feishu Base records.",
    writeOperation: false,
  },
  {
    operationType: "base.read_schema",
    providerResourceTypes: ["base", "base_table", "base_view"],
    description: "Refresh Feishu Base table schema metadata.",
    writeOperation: false,
  },
  {
    operationType: "base.mutate_records",
    providerResourceTypes: ["base", "base_table"],
    description: "Mutate Feishu Base records through an approved DofeAgent operation.",
    writeOperation: true,
  },
];
