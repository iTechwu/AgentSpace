# Claude 真实 CLI 端到端验收清单（E2E）

> 范围：在**指定 CI 环境**用真实 Claude Code CLI 验证“任务调用 MCP 工具”完整闭环。本机（工作站）按 CLAUDE.md 不执行部署/CI，仅提供验收清单与预期结果。
>
> 前置：控制面 + 在线 Docker Runtime daemon + MCP 市场已部署；测试目录包含一个 `streamable_http` MCP server（如 GitHub MCP）与一个高风险工具（如 `delete_repo`）。
>
> 通过标准：**全部步骤 PASS 才可把“任务可调用 MCP”从实验升级为正式承诺**。

## 前置条件

- [ ] 固定 Claude Code CLI 版本（记录 `claude --version`），后续回归用同一版本。
- [ ] 已配置测试账号（CLAUDE.md 的 `13800138000`）与至少一个 `online` 且 `mcpEligible=true`（provider=claude）的 Runtime。
- [ ] 测试 DB 已迁移到 `POSTGRES_SCHEMA_VERSION`（当前 64），`runtime_mcp_tool_audit` 含 `event_id` 列。

## 1. 连接安装与验证

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 1.1 | 在 MCP 市场新建连接：合法 endpoint + 密钥 + 仅批准 `search_repos` | 连接进入 `queued_verification`，daemon 完成验证后置 `ready`；UI 显示“已验证” |
| 1.2 | 用错误密钥再建一条连接 | 置 `failed`，错误码为稳定枚举（如 `mcp.authentication_failed`），不泄露远端响应原文 |
| 1.3 | 新增一个目录项（host 不在 allow-list）尝试连接 | 被 `mcp.policy_denied` 拒绝，无连接行产生 |

## 2. 任务授权与 Gateway 调用

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 2.1 | 对运行中 task 调用 `claimMcpTaskSession`（携带 `attemptId`），首次 | 返回 resolved bundle（endpoint + 密钥仅在 daemon 内存），Provider 任务 bundle 中无 endpoint/密钥 |
| 2.2 | 用**相同 attemptId** 重试 claim | 返回**缓存的首次结果**（不降级为空），`mcp_session_claimed_at` 只写一次 |
| 2.3 | 用**不同 attemptId** 再次 claim | 返回空连接列表（拒绝，非“合法空授权”） |
| 2.4 | Claude 任务启动，验证其收到 `--mcp-config` 指向 loopback gateway URL + `--strict-mcp-config` | `ps`/启动日志中 Provider 进程仅见 gateway URL，不见远端 endpoint 或密钥 |
| 2.5 | 在任务中让 Claude 调用已获准工具 `search_repos` | 工具调用成功，gateway 记录 `succeeded` 审计 |
| 2.6 | 让 Claude 调用**未获准**工具（如目录声明但未批准的 `delete_repo`） | 被拒绝，`mock.calls`/远端无该工具调用，返回 `isError=true` |

## 3. 未授权工具拒绝与逐调用复核

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 3.1 | 任务运行中，管理员停用该连接 | 下一次工具调用被 `validate` 端点拦截（`mcp.policy_denied`），任务继续但不再获得该连接工具 |
| 3.2 | 任务运行中，管理员改配 endpoint（不重新验证） | 同上，被逐调用复核拒绝 |
| 3.3 | 用另一任务（另一 runtime 或 task）的 `mcp-session-id` 对当前 gateway URL 发起请求 | 返回 403 `mcp.session_mismatch`（强绑定拒绝） |

## 4. 撤销中断与生命周期

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 4.1 | 任务正常结束 | `revoke()` 关闭已建立 MCP transport/Server，从内存删除 task/session/secret 快照；再对该 gateway URL 请求返回 404 `mcp.session_not_found` |
| 4.2 | 任务取消/超时/失败 | 同上，`finally` 清理生效 |
| 4.3 | 任务结束后用旧 `?session=` token 重放 | 404，token 已失效 |
| 4.4 | daemon 重启 | 已建立 gateway session 全部失效（内存态），无残留审计批处理丢失（每调用逐条上报） |

## 5. 审计落库与幂等

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 5.1 | 查看连接详情“活动”Tab | operations（verify/enable/disable/remove，含 `source` 分类）与 tool audits 聚合展示，时间倒序 |
| 5.2 | 对同一条审计重放相同 `event_id`（直接 POST `/mcp-tool-audits`） | 返回原行，不产生重复记录（`UNIQUE(workspace_id, event_id)`） |
| 5.3 | 上报时篡改 body 的 `taskId` 为另一任务 | 被忽略，审计归属固定为 URL 中的 taskId |
| 5.4 | 上报不存在的 connectionId | 被跳过（connection 不属于该 workspace） |
| 5.5 | 审计记录含 toolName、outcome、latencyMs、redacted summary | 不包含参数原文或返回内容 |

## 6. 健康巡检（联动验证）

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 6.1 | 触发 `/api/cron/runtime-provisioning`（携带 CRON_SECRET） | `mcpHealthChecks` 阶段为到期 `ready` 连接创建 `source='health_check'` verify 操作 |
| 6.2 | 健康验证失败 | 连接置 `degraded`，`health_check_consecutive_failures` 递增，下次巡检按退避延迟 |
| 6.3 | 健康验证成功 | 失败计数清零，`next_health_check_at` 前进到基础间隔 |
| 6.4 | 已存在 in-flight 健康操作时再次调度 | 不产生重复操作（pending/claimed/running 去重） |

## 7. 回归与记录

- [ ] 记录各步骤实测输出/日志片段，失败项附重现步骤与错误码。
- [ ] 全部 PASS 后更新 `05-实施审查与推进.md` 第 3/5 节与 README 发布边界，把 Claude 从“实验能力”升级为“任务可调用 MCP”。
- [ ] Codex 端到端单独验收（隔离用户/项目预置 MCP 配置 + 真实调用），通过后才允许 `MCP_CODEX_EXPERIMENTAL_ENABLED` 默认开放。
