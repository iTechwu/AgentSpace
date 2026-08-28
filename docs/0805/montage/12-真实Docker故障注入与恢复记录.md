# 真实 Docker 故障注入与恢复记录

日期：2026-08-06

本记录针对“跨容器 kill Worker、异步取消、双员工并发、长视频 MP4 回收、最终账单查询”验收。测试使用现有 SSO workspace「优惠豚」，没有创建新的 tenant/team。

## 已执行证据

| 场景 | 证据 | 结果 |
| --- | --- | --- |
| models API 重建 | 镜像 `dofe-models-api:dev-271e028b`；迁移 `20260806120000_harden_delegated_usage_financial_links` 已恢复 | API `/api/health` 返回 `status=ok`，委托金额返回数字字符串 |
| SSO/models 团队映射 | SSO team `3b682106-d377-42f8-ad68-5a9b918a4c87` 对应 models 内部 team `4b4656ee-4e9f-40d1-b65d-32c402d42b96` | AgentSpace 绑定改为先读取 Runtime Credential 的 models canonical team；link/secret 使用内部主键 |
| MCP 真实提交 | queue `queue-mshnan9n-bt30kh46`；`POST /api/daemon/tasks/.../openmontage/jobs` 返回 `201`；Job `om_job_a5f141fb012648ada9e02105d62c9946` | 聊天任务完成接口返回 `200`，Job link 和 models delegation 已创建 |
| 跨容器 kill/restart | Worker 被 `docker kill` 后重新用 compose 拉起；SQLite execution `attempts=2`，同一 Job lease 被重新领取 | 没有创建第二条 delegation；stage credential 重新返回 `200`，预算未重复预留 |
| 清理迁移 | 历史 72 条孤儿 `billing_ledger_entries.usage_log_id` 被保留到 `metadata._legacyUsageLogId` 后置空 | FK 验证完成；财务行未删除，迁移标记 applied |

## 本次真实失败

Job `om_job_a5f141fb012648ada9e02105d62c9946` 在 research 阶段最终为 `FAILED`，错误码为 `OPENMONTAGE_AGENT_EXECUTOR_FAILED`。OpenMontage SQLite 中没有 `openmontage_model_invocation` 行，models 没有新增 usage/charge/ledger，因此失败没有产生消费；但当前 executor 日志只保存 stdout/stderr 字符数，无法从聊天页或日志快速判断是 CLI、网络还是模型响应失败。

这不是计费成功验收：它只证明 kill/restart 不会凭空重复计费，并证明 credential 可以在恢复后重新签发。真正的 MP4 和 token 结算仍需要 executor 成功完成一次模型请求。

## 仍未关闭的部署硬门禁

1. 异步运行中调用 `cancel_video_job`，需验证 Job 进入 `CANCELLED`、在途 invocation 只 release/settle 一次，且不会产生新消费。
2. Claude 与 Codex 两个员工同时提交 Job，需验证 employee/runtime/rootTask/stage/sourceInvocation 全部隔离，并分别可在聊天页查询。
3. `animated-explainer` 长视频需完成 Remotion/HyperFrames、Artifact Bridge 上传和 MP4 Range 回收，随后查询 models usage、charge、ledger 与 AgentSpace `token_usage` 一一对应。
4. Worker 镜像的 `OPENMONTAGE_SERVICE_TOKEN` 和 `OPENMONTAGE_EVENT_SIGNING_SECRET` 当前不在 `.env`，仅存在已运行容器环境；重启必须由 secret manager 或受保护的部署注入恢复，不能依赖手工导出。
5. executor 必须持久化经过脱敏的 stderr 尾部和失败原因，聊天阶段时间线至少显示 `credential_issued`、`executor_started`、`executor_failed/retry`、`artifact_uploaded` 和 `billing_settled`。

## 验收结论

当前状态为“真实 Docker 控制面与计费门禁通过，Worker 恢复链路已验证，模型执行/MP4/最终账单 E2E 未通过”。在上述五项门禁关闭前，不应把本地环境标记为完整视频生产闭环。
