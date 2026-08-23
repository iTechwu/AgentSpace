# DeepSeek Harness Runtime 接入

本目录记录将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入 AgentSpace runtime 队列的产品、架构、实施和验收约束。

## 文档状态

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [01-产品需求与范围.md](./01-产品需求与范围.md) | P0 已实现，发布阻断 | 明确用户价值、模型与能力边界、非目标和发布策略 |
| [02-架构设计与接入契约.md](./02-架构设计与接入契约.md) | P0 Accepted，P2 Proposed | 定义 runtime/provider/harness、进程协议、凭据、事件与数据流 |
| [03-实施路径与改动清单.md](./03-实施路径与改动清单.md) | W1 完成，W0/W2/W3 部分完成 | 按阶段拆解代码、镜像、配置、测试和迁移工作 |
| [04-验收矩阵与风险决策.md](./04-验收矩阵与风险决策.md) | Release blocked | 验收门禁、回滚策略、风险及 ADR 决策 |
| [05-实施记录与验证证据.md](./05-实施记录与验证证据.md) | As built | 记录分支、提交、实际改动、测试结果、阻断项和后续路径 |

## 当前结论

- `deepseek-harness` 应作为独立的 AgentRouter harness/provider 接入，标识建议为 `deepseek-harness`；不要伪装成 `codex`、`opencode` 或通用 OpenAI provider。
- Phase 1 使用官方 `dsh --profile headless "<task>"`，以 stdout/stderr + exit code 作为最小稳定边界；Phase 2 再接 JSON-RPC/ACP 以支持持久会话和更丰富事件。
- 原生模型 ID 保持 `deepseek-v4-pro`、`deepseek-v4-flash`，凭据使用 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`；模型目录与 runtime provider 的协议能力必须分开建模。
- 现有 `agent_task_queue` 不需要复制或新增队列表；任务仍按 `runtime_id` claim，新增的是 provider/harness 适配和 runtime provisioning 能力。
- `../deepseek-harness` 的 `origin` 已切换为 `git@github.com:iTechwu/deepseek-harness.git`。该 remote 配置不进入 Git tree，因此没有额外 commit 可记录。
- 实现位于分支 `techwu/deepseek-harness-runtime`。代码和静态配置已完成本地验证，但由于批准的 Node 24.19 基础镜像不存在、且未提供真实 DeepSeek key，当前不可发布，Web 灰度开关默认关闭。

## 依据

- 本仓库：`packages/daemon/src/agent-router/*`、`packages/daemon/src/provider-runtime/*`、`packages/domain/src/daemon-provider.ts`、`packages/services/src/runtime-provisioning/*`。
- DeepSeek Harness：`apps/cli/README.md`、`packages/bundle/headless/README.md`、`examples/jsonrpc-agent/README.md`、`docs/user/guide/providers.md`、`examples/headless-agent/cordis.yml`。
