# 指定环境完整控制面销毁/恢复 E2E 验收清单

本清单用于在**指定测试环境**验证员工数据持久化控制面在完整销毁后的恢复能力。本清单本身不操作任何基础设施，执行者需在标有 `[ ]` 的每一项记录实际结果并保存证据 JSON。

## 前置条件

- [ ] 已确认当前环境允许销毁 Runtime 容器、Daemon state volume 和临时状态。
- [ ] 已确认可访问集中 PostgreSQL、TOS、Redis/RabbitMQ（由 `../docker-helm.dofe.ai` 管理）。
- [ ] 已确认不会在生产环境执行本清单。
- [ ] 已配置 `DOFE_EAD_DESIGNATED_E2E_ENABLED=true` 以及下文所需的全部环境变量。

## 环境变量

```bash
# 控制开关
DOFE_EAD_DESIGNATED_E2E_ENABLED=true
DOFE_EAD_WORKSPACE_ID=your-test-workspace

# Runtime / Daemon 目标
DOFE_EAD_TARGET_RUNTIME_ID=rt-xxx
DOFE_EAD_TARGET_IMAGE_DIGEST=sha256:...
DOFE_EAD_DAEMON_STATE_VOLUME=vol-xxx
DOFE_EAD_MANAGED_RUNTIME_API_BASE=https://runtime.example

# Provider / Secret / MCP 受管凭证（仅引用名称，不暴露值）
DOFE_EAD_PROVIDER_NAME=openai-managed
DOFE_EAD_SECRET_NAME=openai-api-key
DOFE_EAD_MCP_CONNECTION_ID=mcp-xxx
DOFE_EAD_SKILL_ARTIFACT_DIGEST=sha256:...
DOFE_EAD_SKILL_RELEASE_LOCK_DIGEST=sha256:...

# 测试任务
DOFE_EAD_TEST_TASK_ID=task-xxx
DOFE_EAD_TEST_EMPLOYEE_NAME=recovery-test
DOFE_EAD_TEST_EXPECTED_OUTPUT_PATH=runtime-output/result.json
```

## 验收步骤

### 1. 基线记录

- [ ] 记录当前 workspace head revision ID、manifest digest、去重后总字节数。
- [ ] 记录所有 bound Skill artifact digest 与 release lock digest。
- [ ] 记录 Provider credential 名称、Secret 名称和 MCP connection ID。
- [ ] 记录当前 Runtime image digest、容器 ID 和 Daemon state volume 名称。
- [ ] 运行一次普通任务并确认成功，保存任务 ID 与输出摘要。

### 2. 控制面销毁

- [ ] 停止旧 Runtime 容器（`docker stop` 或对应编排命令）。
- [ ] 删除旧 Runtime 容器，确认容器 ID 不再存在。
- [ ] 删除 Daemon state volume，确认 volume 名称不再存在。
- [ ] 确认本地节点没有残留的 workspace blob cache、mount 或临时 state。

### 3. 控制面重建

- [ ] 使用新 image digest 创建全新 Runtime（image ID 与销毁前不同）。
- [ ] 重新绑定同一员工到新的 Runtime/binding generation。
- [ ] 触发 `rebuild` 恢复操作，确认 operation 进入 `health_check` 阶段。
- [ ] 确认 workspace 从 TOS 重新物化到 Daemon 持久 workspace 并逐文件校验 SHA-256/size。
- [ ] 确认 Skill artifact 与 release lock 重新安装/校验，依赖环境注入成功。
- [ ] 确认 Secret 解密非空且注入到 Daemon 环境。
- [ ] 确认 Provider 探针通过：API-key 形态执行 `/v1/models`；OAuth/文件登录态执行专用探针；managed service 执行服务级健康请求。
- [ ] 确认 MCP verify operation 完成且状态为成功。
- [ ] 确认 operation 进入 `activate` 并完成 head CAS、generation CAS 与不可变审计。

### 4. 恢复后验证

- [ ] 在恢复后的 Runtime 运行真实任务，确认任务成功。
- [ ] 验证任务输出文件路径、大小、SHA-256 与预期一致。
- [ ] 验证新任务提交产生新的 workspace revision，head 正确推进。
- [ ] 验证旧 worker attempt 的 completion/heartbeat 因 generation fencing 被拒绝。
- [ ] 验证 legal hold、retention quota 与 lifecycle 规则在恢复后环境仍然生效。

### 5. 证据与回滚

- [ ] 保存 `designated-e2e-checklist-${runId}.json` 到 `docs/0801/employee-data-durability/evidence/`。
- [ ] 若测试失败，根据影响范围决定是否回滚 image、清理新容器/卷、恢复旧 backup。
- [ ] 在 review doc 中引用本次证据并更新验收矩阵。

## 通过标准

所有 `[ ]` 项标记为完成，且第 4 步中任务输出校验、head CAS 推进、generation fencing 三项全部成功。任一项失败即为本次验收未通过，必须记录失败阶段与日志片段。

## 自动化占位脚本

运行 `node --experimental-strip-types scripts/employee-data-durability/run-designated-e2e-checklist.ts` 可在本地打印本清单。在指定环境配置好环境变量后，脚本会记录 checklist 执行状态并生成证据 JSON；它不会主动销毁任何容器或卷。
