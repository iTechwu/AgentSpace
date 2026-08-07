# Workflow Worker 部署

Workflow Worker 是独立的应用进程，负责定时 Trigger、节点分派、outbox 和故障恢复。它不创建任何数据库或消息中间件；`DATABASE_URL` 必须指向由 `../docker-helm.dofe.ai` 统一维护的共享 PostgreSQL。

必需配置：

- `DATABASE_URL`：共享数据库连接。
- `WORKFLOW_WORKER_ID`：稳定且唯一的实例标识。
- `WORKFLOW_WORKER_POLL_MS`：轮询周期，建议从 `1000` 开始。
- `WORKFLOW_CUTOVER_MODE` 或 `WORKFLOW_CUTOVER_MODES`：全局或 workspace 级切流状态。
- `CRON_SECRET`：与 Web 恢复 Cron 共用的鉴权 secret，只通过运行环境注入。

构建与运行：

```bash
docker build -f deploy/workflow-worker/Dockerfile -t dofe-agent-workflow-worker:local .
docker run --rm --env-file /etc/dofe-agent/workflow-worker.env dofe-agent-workflow-worker:local
```

生产环境应设置只读镜像、非 root 用户、停止超时和实例级日志采集。切换到 `dual_read` 前必须先完成 dry-run 迁移，并确认只有 Workflow Engine 能写 Trigger。
