// workspace state 后置钩子注册表：state-io 不知道具体 hook 内容，
// 仅在读 / 写快照后调用注册的钩子。域模块（documents / channels 等）通过
// registerPostReadHook / registerPostWriteHook 注册自己负责的派生数据
// 修复（典型用例：ensureChannelDocumentAccessSeeds 文档访问种子补全）。
//
// 设计目标：
// - state-io 维持「纯持久化」职责：只负责读 / 写 / 冲突版本管理，不再硬编码
//   任何域派生逻辑。
// - 域逻辑可在合适的初始化时机（services/src/index.ts 模块加载，或
//   workspace bootstrap 入口）注册自己的钩子，避免 state-io 反向依赖域。
// - 钩子按注册顺序串行执行；任何钩子抛错会让上层 state-io 读 / 写失败
//   （与原 ensureChannelDocumentAccessSeeds 抛错行为对齐）。

import type { DofeAgentState } from "@dofe-agent/domain/workspace";

type StateHook = (state: DofeAgentState) => void;

const postReadHooks: StateHook[] = [];
const postWriteHooks: StateHook[] = [];

export function registerPostReadHook(hook: StateHook): void {
  postReadHooks.push(hook);
}

export function registerPostWriteHook(hook: StateHook): void {
  postWriteHooks.push(hook);
}

export function runPostReadHooks(state: DofeAgentState): void {
  for (const hook of postReadHooks) {
    hook(state);
  }
}

export function runPostWriteHooks(state: DofeAgentState): void {
  for (const hook of postWriteHooks) {
    hook(state);
  }
}

// 仅供测试：清空所有钩子，确保单元测试可独立运行。
export function clearStateHooksForTests(): void {
  postReadHooks.length = 0;
  postWriteHooks.length = 0;
}