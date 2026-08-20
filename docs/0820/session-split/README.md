# AI 员工多会话拆分方案
> **实现状态（本次会话 · dev）**：核心后端已落地并通过测试。已实现：四个领域表（`conversation` / `conversation_participant` / `conversation_execution_lane` / `conversation_provider_session`）、`agent_task_queue` 新增 `conversation_id`/`execution_lane_id`、DB 领域访问层 `packages/db/src/conversations.ts`、Router key 改为 `conversation:<id>`（legacy 回退保留）、按 Execution Lane 领取（跨会话并行、同 Lane 串行，legacy 无 Lane 任务回退旧规则）、服务层 `packages/services/src/conversations/`、REST API（创建/列表/读取/归档/恢复/摘要）、`/new` 服务端建会话并跳转稳定 URL、发送路径透传 `conversationId`/`executionLaneId`、单测 `packages/db/src/conversations.test.ts`（7 例，含跨 Lane 并行 claim）。未完成：前端客户端全量接入（`channels-page-client` 仍走 localStorage 快照 + `new=1`）、消息按 `conversation_id` 持久化、发送消息 API、摘要生成 worker、legacy 回填与 feature flag、Runtime capacity 投影。详见各文档标注。


## 1. 结论

AI 员工、聊天会话、Provider Session 和执行队列必须是四个不同对象。

```text
AI 员工
+-- 会话 A
|   +-- 消息流 A
|   +-- Provider Session A
|   +-- 执行队列 A
|   +-- 运行状态 A
+-- 会话 B
    +-- 消息流 B
    +-- Provider Session B
    +-- 执行队列 B
    +-- 运行状态 B
```

用户执行 `/new` 后，系统必须先创建新的服务端 `conversationId`，再进入空白会话。旧会话继续运行，新会话的首条消息直接进入自己的执行队列。两个会话不得因为属于同一用户、同一 AI 员工或同一 Runtime 而互相串行。

同一会话内的消息保持有序；不同会话可以并行。Runtime 容量是资源约束，不是会话身份，也不能被包装成“排在另一个会话后面”。

## 2. 当前问题

当前实现存在四个耦合点：

1. `/new` 只通过 `new=1` 表达空白页面，没有稳定的服务端会话身份。
2. 首条消息发送成功后，URL 回到员工原有 channel，页面重新展示旧消息流。
3. Router Session 对有登录用户的聊天按 `requesterUserId` 聚合，同一用户与同一员工的不同会话仍会合并。
4. Task claim 用“用户 + 员工”判断串行，不同会话会错误地等待同一员工的旧任务。

浏览器 `localStorage` 中的历史快照只能作为过渡，不足以承担跨设备历史、真实恢复、并发状态和队列身份。

## 3. 文档导航

- [00-产品决策与范围.md](./00-产品决策与范围.md)：问题定义、核心概念、产品原则和方案取舍。
- [01-用户旅程与交互规格.md](./01-用户旅程与交互规格.md)：`/new`、历史、`/resume`、后台运行、错误恢复和页面状态。
- [02-领域模型与接口契约.md](./02-领域模型与接口契约.md)：Conversation、Execution Lane、Message、Task Queue、API 和事件契约。
- [03-每会话队列与并发架构.md](./03-每会话队列与并发架构.md)：领取规则、串并行边界、公平性、幂等和故障恢复。
- [04-迁移与实施计划.md](./04-迁移与实施计划.md)：数据库迁移、双写切流、前端改造、回滚和提交顺序。
- [05-测试验收与指标.md](./05-测试验收与指标.md)：功能矩阵、并发测试、可用性任务、观测指标和上线门禁。

## 4. 关键不变量

1. 每个已发送过消息的会话都有不可变 `conversationId`。
2. 每条聊天消息、聊天任务和 Router Session 都能追溯到 `conversationId`。
3. `/new` 不复用旧 Provider Session、Router Session 或旧消息上下文。
4. 同一 Execution Lane 同时最多一个 active task；不同 Execution Lane 可以并行。
5. 旧会话运行时创建新会话，不取消、不暂停、不重排旧会话。
6. 历史会话按 AI 员工聚合，但执行和消息不会在员工级聚合。
7. `/resume` 只打开历史选择器；选择会话后恢复该会话，不发送伪消息。
8. 会话摘要由服务端保存，一句话可识别，不能只存在当前浏览器。

## 5. 研究与验证限制

本方案基于用户截图、复现行为和现有代码路径形成，已经覆盖产品、数据和调度边界；尚未完成 5 至 8 名真实用户的可用性测试。实现进入可测试环境后，应按 [05-测试验收与指标.md](./05-测试验收与指标.md) 执行任务测试和并发故障注入。
