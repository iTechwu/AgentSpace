// state-io 后置钩子注册入口：仅副作用（module load 时注册一次）。
// 由 services/src/index.ts 顶层导入，确保任何 state-io 读 / 写调用之前
// 钩子已就位。
//
// 当前注册的钩子：
// - ensureChannelDocumentAccessSeeds：channels/documents 域派生数据修复，
//   旧实现位于 state-io.ts 内部，cut 1 后迁回域侧。

import { registerPostReadHook, registerPostWriteHook } from "./state-hooks.ts";
import { ensureChannelDocumentAccessSeeds } from "./channel-document-access-seeds.ts";

registerPostReadHook(ensureChannelDocumentAccessSeeds);
registerPostWriteHook(ensureChannelDocumentAccessSeeds);