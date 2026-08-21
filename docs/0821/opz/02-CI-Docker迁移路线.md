# 本机原生开发到 CI Docker 的迁移路线

## 1. 目标架构

本机和 CI 不需要采用完全相同的启动方式，但必须使用相同的运行时、依赖锁、配置 schema 和验证命令。

```text
开发者本机（原生 Node/pnpm）
  -> 提交代码
  -> CI 质量门
  -> CI BuildKit 构建一次
  -> 推送不可变镜像并取得 digest
  -> 按 digest 扫描 + SBOM + 签名/attestation
  -> 验证签名与策略
  -> 指定 CI/测试环境拉取 digest
  -> 共享基础设施的 schema migration 流程
  -> readiness + smoke + 发布证据
  -> 晋级或按旧 digest 回滚
```

PostgreSQL、Redis、RabbitMQ 始终位于 `../docker-helm.dofe.ai` 管理的共享基础设施中。AgentSpace 流水线只消费连接配置，不创建这些服务、初始化容器或数据卷。

## 2. 本机开发契约

保留当前 `pnpm dev` 和本机 daemon 工作流，但补齐以下约束：

1. 增加 `.node-version` 或等价版本文件，与根 engines 和 CI base image 同源。
2. `dofe-agent doctor` 增加 Node/pnpm、CPU 架构、Docker、CA、外部 PostgreSQL 和模型网关检查。
3. 提供单一验证入口，例如 `pnpm run ci:verify`；它不得启动 Jenkins，也不得部署。
4. 本机 `.env` 继续 gitignore；示例模板只放占位符，CI 通过 secret store 注入。
5. Apple Silicon 本机允许使用原生 arm64 开发，但涉及 provider runtime 的验收必须在目标 `linux/amd64` runner 上完成；不要把 QEMU 结果当作生产性能基线。

## 3. CI 流水线建议

### Stage A：源码与依赖预检

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @dofe-agent/db run prisma:generate
node scripts/verify-test-inventory.mjs
node scripts/audit-node-engines.mjs
node scripts/audit-env-templates.mjs
```

要求：

- runner 使用 Node 24 LTS 的固定补丁版；迁移完成前可用 Node 25 临时 lane 做对照，但不得作为最终生产基线。迁移提交必须同步更新根 `README.md`、`CONTRIBUTING.md` 和 `docs/0814/node-runtime-matrix.md`。
- pnpm 版本从根 `packageManager` 读取，避免在多份 Dockerfile 和 CI 脚本手工重复。
- 安装 registry 与 audit/SCA 数据源分离，避免 npmmirror 不支持 audit endpoint 导致安全门失效。

### Stage B：静态质量门

```bash
pnpm run typecheck
pnpm run lint:web
pnpm exec turbo run test --concurrency=2
```

要求：

- 先修复当前 inventory 和 lint 基线，禁止以 ignore/allow-failure 上线。
- 不运行无并发约束的全量测试；API/Jest 单文件继续使用 `--runInBand`，API package 全量最多 `--maxWorkers=2`。
- 给非 Web workspace 增加 lint 后，再将根 lint 切为 Turbo task。

### Stage C：测试分层

| Lane | 环境 | 触发 | 说明 |
| --- | --- | --- | --- |
| unit | Node + 外部测试 PG | 每个 PR | pure/node:test/Vitest，Turbo 并发 2 |
| DB integration | 独立测试数据库 | 每个 PR 或 merge queue | 数据库名/schema 必须隔离，禁止连生产 |
| Docker integration | 目标 Linux runner | merge/main | daemon dist、iptables/egress、read-only FS、信号退出 |
| browser E2E | Web + 测试服务 | merge/main | 6 个 Playwright spec，保存 trace/screenshot |
| external smoke | 指定测试环境 | 人工批准或发布候选 | TOS、SSO、飞书、模型计费；凭据来自 secret store |

### Stage D：镜像构建矩阵

建议产物：

| 镜像 | 构建策略 | 运行内容 |
| --- | --- | --- |
| `agentspace-web` | Next `output: standalone` | minimal `server.js` + static/public + 必需 native/runtime 文件 |
| `agentspace-workflow-worker` | esbuild/tsc bundle | 编译后 JS + Prisma runtime，不带 pnpm/源码 |
| `agentspace-feishu-worker` | 编译产物镜像，或正式退役独立模式 | 不再挂载宿主源码；若由 daemon 托管，删除独立部署入口 |
| `agentspace-daemon` | 复用当前 tgz/dist | daemon dist + 选定 provider CLI |
| `agentspace-mcp-egress-proxy` | 保留 esbuild 单文件 | Node runtime + `dist/index.js` |
| `agent-runtime-<provider>` | provider 基础镜像 + daemon wrapper | 每 provider 单独构建、签名、准入 |
| `employee-runtime-recovery` | 仅作为按需演练镜像 | 不进入常驻服务矩阵；按 digest 保存演练证据 |

构建规则：

- 使用 `docker buildx bake` 或等价矩阵，一次解析共同 build stage，统一 cache key。
- 统一 `.dockerignore`；Workflow Worker 当前缺少 ignore，应作为第一项修复。
- 使用 BuildKit registry cache；pnpm store cache id 包含 Node major、pnpm 版本和 lockfile digest。
- base image、provider image 和最终部署全部锁 digest。
- 每个 provider 最终镜像都验证实际 `node --version`、daemon 启动和 provider smoke；只验证 wrapper build stage 不足以证明运行时版本一致。
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` 不再通过普通 Docker `ARG` 传入。使用 BuildKit secret/env mount，运行时注入同一 key，并验证多副本一致性。
- `PROVIDER_INSTALL_COMMAND` 不接受包含凭据的任意 shell。长期目标是使用已审核、已签名的 provider 基础镜像。

### Stage E：供应链门

每个最终镜像至少生成：

- OCI labels：source、revision、version、created。
- SPDX 或 CycloneDX SBOM。
- OS 与 npm 依赖漏洞报告；high/critical 默认阻断，例外必须有 owner、可达性说明和到期日。
- provenance/attestation。
- cosign 签名；managed node 除校验签名外，还校验允许的 registry、revision 和目标架构。

建议标签同时保留 `git-<sha>`、语义版本和环境别名，但部署清单只落 digest。生产和测试不得依赖 `latest`。

### Stage F：部署与回滚

1. CI 推送并验证候选 digest，不在应用 Compose 中创建 PostgreSQL、Redis、RabbitMQ 或任何数据库初始化 job。
2. 如有 schema 变更，由 `../docker-helm.dofe.ai` 所属的获准外部控制流程完成，并保存版本与结果证据。
3. 在目标环境更新 digest 清单，启动新 Web/Worker/daemon 实例。
4. readiness 通过后再接流量；执行 SSO、workspace、任务 claim、blob 小文件和 provider smoke。
5. 保留旧实例或旧 digest，观察窗口内无异常后再清理。
6. 失败时恢复上一 digest；数据库变更必须遵循 expand/contract，确保应用回滚兼容。

现有应用 Compose 中的 `db-init -> web` 依赖应移除；生产 Compose 从 `build:` 改为 `image: registry/name@sha256:...`，只连接共享基础设施。

指定 CI/测试环境仍遵循项目既定入口：本机实现并验证后提交，push 到目标分支，触发与该提交匹配的 Jenkins 部署，并持续监控 Jenkins build 与部署后服务健康，直到得到明确成功或失败结论。本工作站不得启动或触发 Jenkins；生产环境切换需使用另行批准的发布流程。

现有 systemd 服务在迁移期只作为受控回退路径，禁止继续从宿主源码构建新版本；对应容器稳定后逐项退役。独立飞书 Worker 必须在“独立镜像化”和“由 daemon 托管并删除独立入口”之间做出显式选择。

## 4. 容器运行基线

所有不需要特权的服务默认使用：

- 非 root 固定 UID/GID。
- `read_only: true`，只为明确的数据目录挂 volume，临时目录用受限 tmpfs。
- `security_opt: [no-new-privileges:true]`、`cap_drop: [ALL]`，按需最小回加。
- 显式 CPU/内存/PID/ulimit，依据压力测试设置，不照搬猜测值。
- liveness/readiness/startup 分离；SIGTERM grace period 大于 worker 最大安全收尾时间。
- 结构化 stdout/stderr，不把 secret、Bearer、预签名 URL 写入日志。

managed node 是特例：它挂载 Docker socket、默认 root、host network，并需要网络管理 capability，等价于高权限节点。应运行在专用隔离主机，限制 CI 身份与镜像准入，不能与普通 Web/Worker 混部。长期可评估受限的 container runtime API proxy，减少直接暴露 Docker socket。

## 5. 健康检查契约

| 服务 | Liveness | Readiness |
| --- | --- | --- |
| Web | 事件循环可响应 | DB 查询、schema 版本、必需配置可用 |
| Workflow Worker | 主循环/心跳仍推进 | DB 可用、最近 tick 未持续失败 |
| daemon | 进程和本地状态可读 | 已注册、heartbeat 正常、provider 必需能力可用 |
| MCP proxy | HTTP server 可响应 | policy 快照、验签公钥、状态目录可用 |
| runtime-maintenance | 进程存活 | 最近成功 reconcile 未超过阈值 |

外部模型、飞书、TOS 不应放入高频 readiness，否则第三方抖动会让实例被持续摘流，并可能在错误配置 liveness 时放大为重启；它们应进入独立 dependency health 指标和告警。

## 6. 缓存与性能预算

首轮只记录基线，不立即因阈值失败：

- install、typecheck、test、Next build、每个 Docker target 的耗时。
- build context、cache hit rate、镜像压缩/解压体积。
- Web CSS、关键 route 首载 JS、Lighthouse/Playwright Web Vitals。
- 容器启动到 readiness 时间、空闲 RSS、并发请求 RSS、event-loop lag。

基线稳定两周后开始阻断回归，例如镜像或首载资产增长超过 10%，或者 API p95 超过已批准预算。

## 7. 推荐提交拆分

1. 修复 test inventory 和 Web lint。
2. 修复 Prisma/deepmerge 生产依赖漏洞。
3. Node 24 LTS 兼容迁移。
4. 增加 CI verify job，不部署。
5. 增加统一 Docker ignore、Web standalone、Worker bundle。
6. 增加 SBOM/scan/sign 和不可变 tag。
7. 增加 readiness 与容器 hardening。
8. 按“本机验证与提交 -> push -> 匹配 Jenkins 部署 -> 持续监控”的既定闭环，将指定测试环境切换为 digest 部署；观察后再通过另行批准的流程替换旧生产 workflow。

每一步都应保持仓库可构建并单独提交。指定 CI/测试环境的 Jenkins 操作只能在对应环境执行；本机到实现、验证和提交为止，不执行 push、Jenkins 或部署，除非用户另行明确授权符合规则的后续动作。

## 8. Go / No-Go

满足以下条件后，才建议让 CI 自动部署 Docker：

- [ ] pretest、typecheck、lint、unit/integration 全绿。
- [ ] E2E 与真实 Docker egress gate 有最近一次成功证据。
- [ ] Node runtime 仍在官方支持期。
- [ ] production audit 无未批准 high/critical。
- [ ] 镜像按 digest 部署，SBOM、扫描、签名齐全。
- [ ] Web/Worker/daemon readiness 有效，回滚只需恢复旧 digest。
- [ ] 大对象上传/下载在容器内存预算下通过压力测试。
- [ ] 部署清单没有 PostgreSQL、Redis、RabbitMQ 服务或卷。
- [ ] secrets 不经过普通 build args，不出现在镜像 history/provenance/log 中。
- [ ] 数据库变更满足向前/向后兼容和回滚演练要求。
