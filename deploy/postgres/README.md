# 外部 PostgreSQL 连接说明

AgentSpace 不再提供 PostgreSQL 的 Docker Compose、初始化容器或持久化卷。PostgreSQL、Redis、RabbitMQ 由同级目录 `../docker-helm.dofe.ai` 统一管理。

本目录仅保留这个说明，避免误把应用仓库当作基础设施所有者。请在部署前通过 `DATABASE_URL`、`REDIS_URL` 等环境变量指向已获准的外部服务，并由基础设施仓库的迁移流程执行 schema 变更。
