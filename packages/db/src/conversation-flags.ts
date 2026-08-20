// 多会话拆分特性开关（docs/0820/session-split §4）。全部由服务端环境变量控制，浏览器不能通过
// query 参数开启队列规则。默认值反映「已完成的 rollout」状态（对应文档 Phase 2/3/4 已切换）；文档
// 表格中的「off」是灰度上线起始状态。

export type TaskQueueByConversationMode = "off" | "shadow" | "on";

export interface ConversationFeatureFlags {
  /** 创建与读取服务端 Conversation（off 时回到 legacy 页面读写）。 */
  conversationV2Enabled: boolean;
  /** legacy 写路径同步写 Conversation。本代码库无独立 legacy 写路径（send 本身即 V2 路径），此开关保留占位、恒不影响行为。 */
  conversationV2DualWrite: boolean;
  /** 聊天任务 claim 串行键：on=按 Lane；off/shadow=legacy（requester+employee）。
   *  shadow 的「记录 Lane 会选什么」观测尚未实现，当前行为等同 off（回滚安全）。 */
  taskQueueByConversation: TaskQueueByConversationMode;
  /** 历史面板读服务端会话。off 时历史列表返回空（本地快照面板已移除，属降级而非完整回退）。 */
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
