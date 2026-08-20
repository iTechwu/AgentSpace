// 多会话拆分特性开关（docs/0820/session-split §4）。全部由服务端环境变量控制，浏览器不能通过
// query 参数开启队列规则。默认值反映「已完成的 rollout」状态（对应文档 Phase 2/3/4 已切换）；文档
// 表格中的「off」是灰度上线起始状态。

export type TaskQueueByConversationMode = "off" | "shadow" | "on";

export interface ConversationFeatureFlags {
  /** 创建与读取服务端 Conversation（off 时回到 legacy 页面读写）。 */
  conversationV2Enabled: boolean;
  /** legacy 写路径同步写 Conversation（当前无 legacy 双写路径，保留占位）。 */
  conversationV2DualWrite: boolean;
  /** 聊天任务 claim 串行键：on=按 Lane；off=legacy（requester+employee）；shadow=按 Lane 并记录 legacy 选择。 */
  taskQueueByConversation: TaskQueueByConversationMode;
  /** 历史面板读服务端会话（off 时历史面板退回空/本地）。 */
  conversationHistoryServer: boolean;
  /** 显式 Runtime 任务容量控制与投影。 */
  runtimeTaskCapacityEnabled: boolean;
}

export function readConversationFeatureFlags(env: NodeJS.ProcessEnv = process.env): ConversationFeatureFlags {
  return {
    conversationV2Enabled: resolveBoolean(env.CONVERSATION_V2_ENABLED, true),
    conversationV2DualWrite: resolveBoolean(env.CONVERSATION_V2_DUAL_WRITE, false),
    taskQueueByConversation: resolveTaskQueueMode(env.TASK_QUEUE_BY_CONVERSATION),
    conversationHistoryServer: resolveBoolean(env.CONVERSATION_HISTORY_SERVER, true),
    runtimeTaskCapacityEnabled: resolveBoolean(env.RUNTIME_TASK_CAPACITY_ENABLED, false),
  };
}

function resolveBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function resolveTaskQueueMode(value: string | undefined): TaskQueueByConversationMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "shadow") {
    return "shadow";
  }
  return "on";
}
