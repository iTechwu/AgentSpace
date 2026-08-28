// 3.5-4：原 1,820 行单文件按职责拆分至 provider-runtime/ 子模块。本文件
// 保留为 barrel，显式重导出原有 15 个公共符号（8 类型 + 7 值）；模块间
// 内部依赖（事件映射、凭据探测等）不在此暴露。
export type {
  DetectedProvider,
  ProviderApprovalDecision,
  ProviderApprovalRequest,
  ProviderRuntimeRecord,
  ProviderTaskEvent,
  ProviderTaskOptions,
  ProviderTaskStructuredError,
  RemoteRuntimeRecord,
} from "./provider-runtime/types.ts";
export { detectProviders, resolveModelId } from "./provider-runtime/catalog.ts";
export { runProviderTask } from "./provider-runtime/agent-router-task.ts";
export { buildProviderRuntimeMetadata, readNodeMetadata } from "./provider-runtime/metadata.ts";
export {
  normalizeProviderTaskErrorCategory,
  readProviderTaskFailureMetadata,
} from "./provider-runtime/failures.ts";
