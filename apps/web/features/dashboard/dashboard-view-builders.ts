// 门面：Dashboard 各域 loader 共用的视图构建 helper。历史上这里是单一
// 1,410 行文件，混合频道/知识/飞书/文档变更集与冲突合并多个领域，且并非
// 纯视图构建（会读成员、附件与飞书设置）。现按领域拆入 ./builders/ 各
// 子模块，本文件仅做 re-export，保持 data.ts 等消费方导入路径不变：
//   ./builders/text                 — 共享文本比较
//   ./builders/workspace-members    — 成员缓存读取 + 角色判定/标签
//   ./builders/task-queue           — 任务队列阈值与标题安全解析
//   ./builders/channel-view         — 频道列表项/直聊定位/提及未读
//   ./builders/channel-files        — 附件引用索引/删除权限/预览
//   ./builders/document-changesets  — 文档变更集/冲突合并预览
//   ./builders/channel-documents    — 频道文档域视图装配
//   ./builders/knowledge-view       — 知识文档页记录装配
//   ./builders/feishu-summary       — 飞书频道绑定摘要
// 依赖方向：data.ts → 本门面 → builders/*（builders 之间仅沿上述列表
// 自上而下引用，无环）。
export {
  sameText,
} from "./builders/text";
export {
  formatWorkspaceRoleLabel,
  isWorkspaceManagerRole,
  listWorkspaceMemberUsersCached,
} from "./builders/workspace-members";
export {
  TASK_QUEUE_DELAY_THRESHOLD_MS,
  safeReadTaskTitle,
} from "./builders/task-queue";
export {
  buildChannelListItem,
  buildMentionUnreadViewer,
  getVisibleWorkspaceChannelNames,
  hasUnreadMentionForViewer,
  isDirectChannelRecord,
  normalizeChannelScope,
  resolveDirectChannelForContact,
  type MentionUnreadViewer,
} from "./builders/channel-view";
export {
  buildAttachmentReferenceIndex,
  buildChannelFileDeleteMetadata,
  deriveAttachmentFileName,
  isAttachmentReferencedByKnowledgeOrDocument,
  readMarkdownAttachmentPreviewText,
  type AttachmentReferenceIndex,
} from "./builders/channel-files";
export {
  CHANNEL_DOCUMENT_SYNC_EVENT_TTL_MS,
  buildChannelDocumentChangeSetRecord,
  buildChannelDocumentConflictMergePreview,
  buildChannelDocumentSyncEventRecord,
  buildSuggestedConflictDraftBlocks,
  isRetryableChangeSetOperations,
  parseChannelDocumentChangeSetOperations,
  serializeConflictDraftBlocks,
  summarizeChangeSetOperations,
} from "./builders/document-changesets";
export {
  buildChannelWorkspaceArtifacts,
} from "./builders/channel-documents";
export {
  buildKnowledgeDocumentPageRecords,
} from "./builders/knowledge-view";
export {
  buildFeishuChannelSummaryByChannelName,
} from "./builders/feishu-summary";
