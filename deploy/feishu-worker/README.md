# 飞书 Worker 独立部署（docker compose）

本目录用于把飞书 WebSocket Worker 作为**独立容器**运行，与 daemon 解耦。镜像只提供
`node` + 固定版本 `pnpm`（构建阶段安装），源码在运行时由 compose 挂载到
`/srv/DofeAgent`，因此本镜像本身不内嵌源码。

> ⚠️ **不要与本地托管模式混用。** 若本机的 daemon 已设置
> `DOFE_AGENT_MANAGE_FEISHU_WORKER=true`，daemon 会自行拉起 worker；此时再启动本
> compose 会出现两个 worker 同时连同一个飞书集成/同一 `WORKER_ID`，造成事件重复消费
> 或互踢。二选一：要么用 daemon 托管，要么用本 compose（并把 daemon 的该开关关掉）。

## 前置条件

- Docker + Docker Compose v2。
- 可拉取基础镜像 `uhub.service.ucloud.cn/techwu/node:25.9-bookworm-slim`（私有仓库，
  需预先登录或在内网节点上构建）。
- **外部托管的基础设施**：PostgreSQL / Redis / RabbitMQ 一律由
  `../docker-helm.dofe.ai` 集中管理，本 compose **不创建、不运行、不内嵌**这些服务。
  `feishu-worker.env` 里的 `postgres:5432` 等地址必须指向你已部署的外部实例。
- 仓库源码已在本机检出：compose 通过 `../..:/srv/DofeAgent` 挂载**整个仓库**，worker
  实际运行的是挂载进来的源码。因此容器启动前，**必须先在宿主仓库内安装依赖并构建**：

  ```bash
  # 在仓库根目录（deploy/feishu-worker 的上两级）
  pnpm install --frozen-lockfile
  pnpm run build
  ```

  未构建时 `pnpm run cli` 会因找不到产物而失败。

## 配置

```bash
cd deploy/feishu-worker
cp feishu-worker.env.example feishu-worker.env
# 按外部基础设施地址、飞书集成凭据填写 feishu-worker.env
```

必填项见 `feishu-worker.env.example`，尤其：

- `DOFE_AGENT_PG_URL` / `DATABASE_URL`：指向外部 PostgreSQL。
- `DOFE_AGENT_FEISHU_CREDENTIAL_ENCRYPTION_KEY`：base64 编码的 32 字节密钥。
- `DOFE_AGENT_FEISHU_INTEGRATION_ID` / `DOFE_AGENT_FEISHU_WORKER_ID`：本 worker 的唯一标识，
  `WORKER_ID` 在同一集成内必须唯一，避免多副本互踢。

## 启动

```bash
cd deploy/feishu-worker
docker compose up -d --build
```

`--build` 首次会构建本目录的 `Dockerfile`（安装 pnpm）；后续源码变更通过重新挂载即时
生效，但**依赖或构建产物变更需要先在宿主仓库重新 `pnpm install` / `pnpm run build`**。

查看日志 / 状态：

```bash
docker compose logs -f feishu-worker
docker compose ps
```

worker 通过 WebSocket 长连对接飞书；日志中出现已连接 / 心跳即视为就绪。

## 升级

源码即挂载内容，升级流程围绕仓库提交展开：

1. 在宿主仓库拉取目标版本并重建依赖与产物：

   ```bash
   git fetch origin && git checkout <目标提交>
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. 若 `deploy/feishu-worker/Dockerfile`（pnpm/node 版本）有变，重建镜像：

   ```bash
   cd deploy/feishu-worker
   docker compose build
   ```

3. 重启容器使新代码/镜像生效：

   ```bash
   docker compose up -d
   ```

飞书 worker 为无状态长连进程，重启会断开当前 WebSocket 并重连，期间事件由飞书服务端
在重连后补推。升级窗口应尽量短并确认 `WORKER_ID` 不变。

## 回滚

回滚即回到上一个已验证提交：

```bash
git checkout <上一个可用提交>
pnpm install --frozen-lockfile
pnpm run build
cd deploy/feishu-worker
docker compose up -d        # 如镜像层也需要回退，先 docker compose build
```

如需更稳的回滚，可在升级前 `docker tag` 当前镜像为一个版本标签，回滚时
`docker compose up -d` 指向该标签。worker 不持有本地持久状态，无需数据回滚。

## 故障排查

- **启动即退出 / `corepack` 相关报错**：确认走的是本 `Dockerfile`（构建阶段 `npm
  install --global pnpm`），而不是旧版依赖容器内 `corepack enable` 的流程。
- **`pnpm run cli` 找不到模块**：宿主仓库未 `pnpm install` 或未 `pnpm run build`。
- **事件重复或 worker 反复掉线**：多半是与 daemon 托管模式并存，或多个副本用了相同
  `DOFE_AGENT_FEISHU_WORKER_ID`；按上方「不要混用」与唯一 `WORKER_ID` 要求核对。
- **连不上数据库**：`feishu-worker.env` 里的 PG 地址不是本 compose 提供的，必须指向
  `../docker-helm.dofe.ai` 管理的外部实例。
