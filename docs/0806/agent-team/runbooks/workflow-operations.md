# 工作流引擎运维手册

## 1. 适用范围与安全边界

本文用于通用自动化引擎的 Workflow Worker、调度器、Outbox、Runtime 和数据留存故障。所有 SQL 先使用只读账号执行；恢复写操作必须记录 workspace、workflow、run、操作者和变更原因。不得把 graph input、员工 instruction、Secret 或 Provider 原始错误复制到工单、日志或指标标签。

本机仅允许实现与验证，不启动或触发 Jenkins。PostgreSQL、Redis、RabbitMQ 由 `../docker-helm.dofe.ai` 统一管理，本应用不得创建、重启或清空这些共享依赖。

## 2. 统一检查

```bash
systemctl status dofe-agent-workflow-worker --no-pager
journalctl -u dofe-agent-workflow-worker --since "15 minutes ago" --output=json
```

日志只应包含 `eventCode`、`workspaceId`、`workflowId`、`runId`、`nodeRunId`、状态、计数和耗时。排障前记录当前 `WORKFLOW_CUTOVER_MODE` 与 `WORKFLOW_CUTOVER_MODES`，确认影响范围。

## 3. Worker 停止或反复重启

**告警信号：** Worker 心跳超时，`workflow_trigger_lag_seconds` P95 超过 60 秒，或 systemd restart 次数持续增加。

**只读诊断：** 查看 systemd 状态与脱敏日志；查询最近 15 分钟 worker lease、待执行 trigger、running node 和未发送 Outbox 数量；检查外部数据库连通性与 Runtime 健康，不修改 lease。

**恢复动作：** 修复配置或依赖后执行 `systemctl restart dofe-agent-workflow-worker`。确认新 Worker ID 获得 lease，触发恢复扫描；通过 trigger dedupe key 和 node execution key 验证没有重复 Run/任务。

**禁止动作：** 不手工删除 lease、Run 或 Outbox；不绕过幂等键批量补建 Run；不在本机启动 Jenkins；不启动临时 PostgreSQL、Redis 或 RabbitMQ。

## 4. Outbox 积压

**告警信号：** 待发送 Outbox 数持续增长、最老记录年龄超阈值，或 `workflow_node_failures_total` 同时升高。

**只读诊断：** 按 workspace、event type 和状态聚合 Outbox；查看最老记录的稳定 ID、attempt count、nextAttemptAt 和错误码；核对下游 Runtime/通知通道健康，不读取 payload 原文。

**恢复动作：** 恢复下游后让 dispatcher 按 backoff 自动重试；仅对确认可重放且幂等键完整的记录执行受审计的 retry；控制批量和并发，观察 backlog 下降。

**禁止动作：** 不直接改成 sent，不清空表，不把 payload 或 Provider raw message 输出到日志，不提高为无限并发。

## 5. 事件 sequence gap

**告警信号：** 运行详情返回 gap 标记，连续 event sequence 缺号，或客户端从全量快照反复恢复。

**只读诊断：** 按 `runId` 查询最小/最大 sequence、缺失区间和事件写入时间；核对 Run/NodeRun 当前事实和 Outbox 投递状态；判断是展示投影缺失还是事实事件缺失。

**恢复动作：** 展示投影缺失时从 Run/NodeRun 事实重建快照；事件事实缺失时保留 gap 并触发人工介入，禁止伪造历史事件。客户端继续使用全量快照并从最新 sequence 订阅。

**禁止动作：** 不重排 sequence，不复用已有 sequence，不为“看起来连续”而插入虚构事件。

## 6. 重复 Run 或重复下游任务

**告警信号：** 同一 `workspaceId + triggerId + scheduledFor` 出现多个 Run，或同一 node execution key 对应多个外部任务。

**只读诊断：** 查询 trigger dedupe key、Run 来源和创建时间；检查 Worker lease 切换、misfire 恢复及 completion 重放；确认重复项是否已产生外部副作用。

**恢复动作：** 暂停受影响 workflow；保留最早的合法 Run，对未执行副作用的重复 Run 执行受审计取消；已产生副作用时交由业务负责人补偿。修复唯一约束或幂等路径后再恢复。

**禁止动作：** 不删除重复记录，不静默标记 succeeded，不重复发送通知或调用外部工具。

## 7. Runtime 离线或授权撤销

**告警信号：** employee task 长时间 queued、Runtime health offline、grant generation 不匹配，或凭据已撤销。

**只读诊断：** 查询 employee snapshot、Runtime 绑定、grant generation、任务状态和失败码；只检查凭据引用是否存在，不读取或输出凭据值。

**恢复动作：** Runtime 恢复后仅重试尚未产生副作用的节点；授权撤销必须重新预检并发放新 generation，旧任务保持失败或取消。需要替换员工时发布新 workflow version。

**禁止动作：** 不复用已撤销 grant，不修改已发布版本的 employee snapshot，不在日志打印环境变量。

## 8. 预算暂停与人工恢复

**告警信号：** Run 状态 paused 且错误码为预算门禁，`workflow_manual_intervention_total` 增加。

**只读诊断：** 查看预算策略 ID、已用额度、预估剩余额度、暂停节点和最近成功 checkpoint；不要读取员工输入输出正文。

**恢复动作：** 由有预算权限的操作者调整额度或终止 Run；恢复前重新预检，记录审批与理由，从 checkpoint 继续且保留原幂等键。

**禁止动作：** 不绕过预算检查直接改 running，不重置累计使用量，不由 Worker 自动提高额度。

## 9. 按 workspace 回滚切流

切流顺序为 `legacy_only -> dual_read -> workflow_engine -> legacy_archived`。出现新引擎故障时，仅修改受影响 workspace 的 `WORKFLOW_CUTOVER_MODES`：

1. 先暂停相关 Workflow trigger，等待正在执行的 Run 到达安全状态。
2. 从 `workflow_engine` 回到 `dual_read` 做只读核对；只有 legacy trigger 仍完整且不会双调度时才回到 `legacy_only`。
3. 验证一个 trigger owner、日历/自动化投影去重、历史 Run 可读。
4. 记录切流前后值、影响 workspace、验证人和时间。

不得全局回退以处理单 workspace 故障；不得同时启用 legacy 与 workflow 两个 trigger owner；`legacy_archived` 不允许自动回滚到会重新调度旧规则的状态。

## 10. 数据留存与 Legal Hold

**告警信号：** 留存任务失败、待清理数据持续增长、Legal Hold workspace 出现删除计划。

**只读诊断：** 按 workspace 查询 retention policy、Legal Hold 状态、候选 Run/Artifact 数量和最早时间；核对审计记录及对象存储引用，不读取 Artifact 内容。

**恢复动作：** Legal Hold 生效时取消清理任务并保留不可变审计；非 Hold 数据按策略分批归档/删除，删除前后核对引用计数和审计数量。

**禁止动作：** 不覆盖 Legal Hold，不手工删 Run、Event、Artifact 或审计记录，不以数据库空间为由缩短租户策略。

## 11. 恢复完成标准

- 单一 Worker lease 与单一 trigger owner 成立。
- trigger lag P95 回到 60 秒以内，Outbox backlog 持续下降。
- 重复 Run、重复下游任务和未解释 sequence gap 均为 0。
- 抽查工作流保持串行、并行汇聚和汇总员工的预期顺序。
- 安全日志无输入正文、Secret、Provider raw message。
- 变更、人工介入和回滚均有审计记录。
