// 模型客户端与供给流水线共享的结果类型。
// 独立成文件以保持 models-client 与 pipeline 之间单向依赖（pipeline → models-client）。

/** Minimal structural type over the SDK client surface the pipeline uses. */

export interface ModelsCreateResult {
  credential: { id: string; keyFingerprint?: string };
  secret?: { apiKey: string };
  secretIssued: boolean;
}
