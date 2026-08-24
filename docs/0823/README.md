# DeepSeek Harness Runtime 接入

本目录记录将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接入 AgentSpace runtime 队列的产品、架构、实施和验收约束。

## 文档状态

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [01-产品需求与范围.md](./01-产品需求与范围.md) | P0 已实现，发布阻断 | 明确用户价值、模型与能力边界、非目标和发布策略 |
| [02-架构设计与接入契约.md](./02-架构设计与接入契约.md) | P0 Accepted，P2 standalone 队列门禁已实现 | 定义 runtime/provider/harness、进程协议、凭据、事件与数据流 |
| [03-实施路径与改动清单.md](./03-实施路径与改动清单.md) | W1 完成，W0/W2/W3 部分完成，W4 有上游阻断 | 按阶段拆解代码、镜像、配置、测试和迁移工作 |
| [04-验收矩阵与风险决策.md](./04-验收矩阵与风险决策.md) | Release blocked | 验收门禁、回滚策略、风险及 ADR 决策 |
| [05-实施记录与验证证据.md](./05-实施记录与验证证据.md) | As built | 记录分支、提交、实际改动、测试结果、阻断项和后续路径 |

## 当前结论

- `deepseek-harness` 应作为独立的 AgentRouter harness/provider 接入，标识建议为 `deepseek-harness`；不要伪装成 `codex`、`opencode` 或通用 OpenAI provider。
- Phase 1 使用官方 `dsh --profile headless "<task>"`，以 stdout/stderr + exit code 作为最小稳定边界。AgentRouter 已增加默认关闭的一次性 JSON-RPC 协议基础，用 fake runtime 验证握手、owned receipt、durable turn/step 边界、七类 `StreamChunk` 状态、文本/工具/canonical usage 映射、reasoning 隔离、未知 required event、资源释放、ACK/无 ACK 有界退出和进程级取消。provider queue 现在可由 daemon 操作员以 carrier/config/平台 sidecar 完整摘要明确准入，Cordis config 必须匹配仓库内固定 tag 的批准模板，health 只在全部 pin 通过后执行有界 wire 握手；专用 Dockerfile、named bundle context、固定 fork commit 的 wheel 导入器和 managed attestation 也已交付。托管路径不只信任 marker/image label：catalog、task、health 会在 spawn 前重读严格 `provenance.json`，绑定固定 source/wheel 与同目录 carrier/sidecar pin；build 脚本还会在 tag 前运行镜像内 release verifier，严格校验后原子输出无路径/无 credential 的 wire evidence。发布后 runner 只接受 repository、独立 64 位 image SHA-256 与完整 immutable ref 三者一致的镜像，并冻结公钥/release evidence 私有快照、校验独立批准公钥 fingerprint，再以隔离且有界的 cosign 验签在 Docker/API key 暴露前 fail-closed；之后以隔离 carrier 环境完成 Flash/Pro 两个完整回合，并将签名公钥摘要、模型状态与 canonical usage 绑定 release evidence 后原子输出。受控部署脚本在同一环境中完成该 canary 后，才以 `--pull never --no-build` 启动结构化 digest Compose；通用 remote-images 不依赖 DeepSeek 变量。Docker client 和唯一命名容器在正常、非零、超时路径均有界清理；当前只有 fake cosign/carrier/Docker deploy shim 契约证据。默认仍关闭，真实 wheel/bundle/已签名 image/release evidence/模型 canary evidence 尚未取得，且 task-scoped Skill/credential 环境在上游已提供 per-session environment wire 后，AgentSpace 仍禁止跨任务复用进程。上游 fork 已提供 session cancel/resume/approval-policy 与 endpoint overlay，但当前 AgentSpace 尚未消费逐请求 approval/session close/turn cancel ACK，跨进程 resume 也缺真实恢复证据。
- 原生模型 ID 保持 `deepseek-v4-pro`、`deepseek-v4-flash`。生产受管 runtime 的 `DEEPSEEK_API_KEY` 必须来自 Models `RuntimeCredential`，`DEEPSEEK_BASE_URL` 必须由 `MODELS_GATEWAY_BASE_URL/v1` 派生；直连 DeepSeek endpoint 仅用于 standalone 协议测试。模型目录与 runtime provider 的协议能力必须分开建模。
- 发布部署使用 `deploy-deepseek-runtime.sh`：同一环境先完成签名与双模型 canary，再以 `--pull never --no-build` 启动专用结构化 digest Compose；通用 `docker-compose.remote-images.yml` 不要求 DeepSeek 变量，本地构建使用 `docker-compose.runtimes.yml`。
- 现有 `agent_task_queue` 不需要复制或新增队列表；任务仍按 `runtime_id` claim，新增的是 provider/harness 适配和 runtime provisioning 能力。
- `../deepseek-harness` 的 `origin` 已切换为 `git@github.com:iTechwu/deepseek-harness.git`。该 remote 配置不进入 Git tree，因此没有额外 commit 可记录。
- 实现位于分支 `techwu/deepseek-harness-runtime`。Provider 账户入口已接入同一 canary flag；MCP 在创建、任务投影、session claim 和 gateway 校验四层对 DeepSeek fail-closed。代码和静态配置已完成本地验证；托管 usage 已保留 `deepseek_native` 协议语义，但由于批准的 Node 24.19 基础镜像不存在、未提供真实 DeepSeek key，且真实 billing/canary/rollback 尚未执行，当前不可发布，Web 灰度开关默认关闭。

## 依据

- 本仓库：`packages/daemon/src/agent-router/*`、`packages/daemon/src/provider-runtime/*`、`packages/domain/src/daemon-provider.ts`、`packages/services/src/runtime-provisioning/*`。
- DeepSeek Harness：`apps/cli/README.md`、`packages/bundle/headless/README.md`、`packages/sdk/{client,protocol,server}/README.md`、`packages/sdk/server/src/server.ts`、`python/sdk-runtime/README.md`、`examples/jsonrpc-agent/README.md`。
