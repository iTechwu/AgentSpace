// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/documents` 子路径与根 re-export 使用。

export {
  detectDocumentKind,
  parseFileToMarkdown,
  type ParseResult,
  type ParseFailure,
  type SupportedDocumentKind,
} from "../document-parsing/parse-file.ts";

export {
  listChannelDocumentsSync,
  listChannelDocumentVersionsSync,
  listChannelDocumentBlocksSync,
  listChannelDocumentAccessesSync,
  readChannelDocumentSync,
  canViewChannelDocumentSync,
  upsertChannelDocumentPresenceSync,
  clearChannelDocumentPresenceSync,
  createChannelDocumentSync,
  updateExternalChannelDocumentMetadataSync,
  updateChannelDocumentSync,
  renameChannelDocumentSync,
  archiveChannelDocumentSync,
  restoreChannelDocumentSync,
  rollbackChannelDocumentVersionSync,
  exportChannelDocumentAsAttachmentSync,
  createChannelDocumentFromAttachmentSync,
  listChannelMarkdownAttachmentsSync,
  addChannelDocumentCollaboratorSync,
  removeChannelDocumentCollaboratorSync,
  updateChannelDocumentAccessRoleSync,
  recordChannelDocumentConflictSync,
  resolveChannelDocumentConflictSync,
  retryChannelDocumentConflictSync,
  markChannelDocumentRunStepRunningSync,
  completeChannelDocumentRunStepSync,
  failChannelDocumentRunStepSync,
} from "./sync.ts";

export {
  applyChannelDocumentBlockOperations,
  type ChannelDocumentOperation,
} from "./operations.ts";
