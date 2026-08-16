// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/content` 子路径与根 re-export 使用。

export {
  listMaterialsSync,
  addMaterialSync,
  importMaterialFileSync,
  parseMaterialSync,
} from "../materials/materials.ts";

export {
  deleteChannelAttachmentSync,
  deleteUnreferencedWorkspaceAttachmentsSync,
  deleteWorkspaceAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  persistWorkspaceAttachmentFromFileSync,
  readWorkspaceAttachmentBytesSync,
  type DeleteChannelAttachmentResult,
} from "../attachments/attachments.ts";

export {
  createAttachmentStorageClient,
  setAttachmentStorageClientForTests,
  buildContentAddressedBlobKey,
  type AttachmentStorageClient,
  type AttachmentStorageReadInput,
  type AttachmentStorageObjectMetadata,
  type AttachmentStoragePutInput,
  type ContentAddressedBlobPutInput,
  type ContentAddressedBlobReadInput,
  type ContentAddressedBlobRef,
  type StoredAttachmentObject,
} from "../attachments/storage.ts";

export {
  readStoredAttachmentSync,
} from "@dofe-agent/db";

export {
  globalSearchSync,
  type SearchResult,
  type SearchResultType,
  type SearchOptions,
} from "../search/search.ts";

export {
  buildContactAgentContext,
  buildContactAgentContextSync,
  type ContactAgentContext,
  type ContactContextEntity,
} from "../context/provider.ts";

export {
  listWorkspaceContextChannels,
  listWorkspaceContextChannelsSync,
  listWorkspaceContextDocuments,
  listWorkspaceContextDocumentsSync,
  listWorkspaceContextEntities,
  listWorkspaceContextEntitiesSync,
  resolveWorkspaceContextEntity,
  resolveWorkspaceContextEntitySync,
  searchWorkspaceContextMessages,
  searchWorkspaceContextMessagesSync,
  type WorkspaceContextChannelSummary,
  type WorkspaceContextMessageResult,
} from "../context/query.ts";

export {
  listDataTablesSync,
  readDataTableSync,
  createDataTableSync,
  createExternalDataTableSync,
  updateDataTableSync,
  updateExternalDataTableMetadataSync,
  deleteDataTableSync,
  addDataRowSync,
  updateDataRowSync,
  deleteDataRowSync,
} from "../tables/tables.ts";

export {
  listTemplatesSync,
  readTemplateSync,
  createTemplateSync,
  updateTemplateSync,
  deleteTemplateSync,
} from "../templates/templates.ts";
