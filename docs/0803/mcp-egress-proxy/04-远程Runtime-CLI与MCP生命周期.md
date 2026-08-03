# 远程 Runtime 的 CLI 与 MCP 生命周期

> 状态：remote CLI 私有安装、托管 Docker 共享、Streamable HTTP/managed stdio MCP、OAuth broker、task gateway 与市场发布入口均已实施
>
> 部署前提：Docker Compose，不依赖 Kubernetes

本文定义 remote 模式下 CLI/MCP 的所有权、落盘位置和 Runtime Docker 交互方式。目标是避免把工具装进 daemon 的全局环境，也避免把 MCP endpoint、密钥或 OAuth material 放进 Provider 容器。

## 1. 资源放在哪里

| 资源 | 宿主机位置/所有者 | Runtime Docker 视图 | 生命周期 |
| --- | --- | --- | --- |
| CLI 用户级安装根 | `$DOFE_AGENT_DAEMON_STATE_DIR/managed-runtimes/<runtime-id>/home/.local` | `/dofe-home/.local` | 跟随 Runtime，容器重建后保留 |
| CLI 可执行文件 | `<runtime-home>/.local/bin` | `/dofe-home/.local/bin` | 安装、更新、卸载均作用于同一目录 |
| Runtime HOME | `<state>/managed-runtimes/<runtime-id>/home` | `/dofe-home` | 每个 Runtime 独立，禁止跨 Runtime 共享 |
| Skill/CLI 依赖产物 | `<state>/workspaces/<workspace-id>/runtime-app-deps` | `/runtime-app-deps` | 工作区级依赖缓存与审计 digest |
| MCP 目录 release | 控制面现有数据库 | 不挂载 | `slug + semver` 不可变 |
| MCP connection 密钥 | 控制面加密存储，任务 claim 后仅在 daemon 内存解密 | 不挂载、不注入环境变量 | task session 结束即释放 |
| managed stdio MCP 可执行文件 | `<runtime-home>/.local/bin` | `/dofe-home/.local/bin/<entrypoint>` | 先通过 CLI 市场安装，跟随 Runtime 私有 HOME |
| MCP task gateway | remote daemon 进程内存 | Provider 只收到 task URL | task 结束/取消/超时即撤销 |
| MCP egress policy/lease | 控制面签发，daemon/proxy 短期持有 | Provider 不可见 | 按调用复核与消费 |

### 两类 MCP transport 的安装方式

`streamable_http` 不安装进 Runtime：市场发布不可变目录元数据，连接由 daemon 托管，远端 MCP Server 独立运行。Runtime Docker 内没有 MCP server package、长期 token 或 endpoint 配置。

`managed_stdio` 的服务包必须先通过同一个 Runtime 的 CLI 市场安装到私有 `.local`，MCP release 只引用 `stdio://<entrypoint>`，不能包含任意 argv、宿主机路径、`npx`/`uvx` 临时下载命令。daemon 在验证和任务调用时将它解析为私有 `.local/bin/<entrypoint>`；托管节点使用目标 provider 镜像、同一 `/dofe-home`、只读根文件系统和 `--network none` 启动一次性 stdio 容器，并保持 stdin 打开。非托管节点从相同的宿主机私有路径启动。

OAuth broker 客户端在 egress proxy 中运行，refresh token 只属于控制面 token vault。控制面向 proxy snapshot 提供 opaque grant reference，proxy 按调用换取最长一小时的短期 access token；Runtime HOME、Provider 容器和持久 policy cache 均不保存 token material。

## 2. CLI 安装执行链

```text
Web 市场发起 install/update/uninstall
  -> control plane 生成 argv 数组形式的受控计划
  -> remote daemon claim operation
  -> 选择 <runtime-id> 私有 home
  -> host remote: 直接执行受控命令
  -> managed remote: docker run --rm target-provider-image
       mount runtime home -> /dofe-home
       mount workspace deps -> /runtime-app-deps
       join MANAGED_RUNTIME_INSTALL_DOCKER_NETWORK
       inject validated npm/PyPI registry URLs
  -> 在同一环境执行 verifyCommands
  -> 回传状态、脱敏 stdout/stderr、依赖 digest 与安装位置元数据
```

daemon 执行层统一设置：

```text
HOME=<runtime-home>                  # Docker 中为 /dofe-home
PYTHONUSERBASE=<runtime-home>/.local
NPM_CONFIG_PREFIX=<runtime-home>/.local
PATH=<runtime-home>/.local/bin:$PATH
NPM_CONFIG_REGISTRY=<DOFE_AGENT_NPM_REGISTRY>
PIP_INDEX_URL=<DOFE_AGENT_PYPI_INDEX_URL>
UV_DEFAULT_INDEX=<DOFE_AGENT_PYPI_INDEX_URL>
```

安装计划本身不得写死 `/dofe-home`、宿主机绝对目录或 shell 展开符。npm public catalog 使用 `npm install --global <validated-package>`；pip/CLI-Hub 使用参数数组，并由 daemon 决定最终安装根。

Provider task 启动时复用相同 `.local/bin`：host remote 将宿主机目录加入 Agent Router capability PATH；managed remote launcher 将 `/dofe-home/.local/bin` 加入容器 PATH。因此“市场安装成功但任务找不到命令”应视为发布阻断缺陷。

CLI 下载不复用 MCP 的协议代理。daemon 为批准的安装操作启动短生命周期容器，并接入单独的 `MANAGED_RUNTIME_INSTALL_DOCKER_NETWORK`；生产防火墙只允许该网络访问 `DOFE_AGENT_NPM_REGISTRY` 与 `DOFE_AGENT_PYPI_INDEX_URL`。当 `MCP_EGRESS_ENFORCE=true` 时，安装网络必须与 `dofe-runtime-restricted` 分离，两个 HTTPS registry 也必须显式配置。readiness 每 60 秒在目标 provider 镜像中以 `--network none` 挂载同一 Runtime HOME 探测，控制面优先采用 Runtime 级结果，不能再用 daemon 主机结果跳过 bootstrap。

## 3. MCP 与 Runtime Docker 的交互

### Streamable HTTP

```text
managed Provider container
  -> http://<restricted-bridge-gateway>:<ephemeral-port>/mcp?session=<random>
  -> remote daemon task gateway
  -> 每次调用向控制面复核 connection/tool，并取得最新 lease/policy
  -> RuntimeMcpClient
  -> mcp-egress-proxy:8080
  -> approved remote MCP endpoint
```

remote daemon 在托管节点上执行：

1. 校验 `MANAGED_RUNTIME_DOCKER_NETWORK` 是用户自定义隔离网络；
2. 用 `docker network inspect` 读取 bridge gateway IPv4；
3. task gateway 只绑定并发布该地址，不使用 `0.0.0.0`；
4. 创建随机 task session URL，Provider 配置只包含该 URL 与工具 schema；
5. task 结束时撤销 session 并关闭已建立的 MCP transport。

非托管 host remote Runtime 继续绑定 `127.0.0.1`，不会扩大监听面。

### Managed stdio

```text
Provider -> daemon task gateway -> RuntimeMcpClient
  -> docker run --interactive --network none target-provider-image
       mount <runtime-home> -> /dofe-home
       entrypoint=/dofe-home/.local/bin/<catalog-entrypoint>
  -> MCP stdin/stdout
```

连接验证与任务调用使用同一启动构造器，均不接受浏览器传入的 command/args。只有大写环境变量名称可进入进程；`HOME`、`PATH` 与 `DOFE_*` 由 daemon 保留。stdio server 如需访问外部 SaaS，必须等待受控 worker egress 能力并显式发布相应策略；当前 `--network none` 会 fail closed，不得临时接入安装网络或 Runtime 普通网络。

## 4. Remote 节点安装与 Compose 约定

`deploy/install-remote-daemon.sh --managed-node` 会：

- 验证当前用户可执行 Docker；
- 读取或创建 `MANAGED_RUNTIME_DOCKER_NETWORK`；
- 读取或创建独立的 `MANAGED_RUNTIME_INSTALL_DOCKER_NETWORK`，标记为 `dofe.managed-egress=package-install`；
- `MCP_EGRESS_ENFORCE=true` 时要求既有 `dofe-runtime-restricted`，不自行创建一个冒充受限网络；
- 非 enforce 模式自动创建的普通 bridge 明确标记为 `dofe.managed-egress=unrestricted`，不能作为出口安全证明；
- 将两个 network、受控 registry、image tag、TLS CA、extra hosts 与 enforce 状态写入 daemon env；
- 保存 daemon 访问 proxy 所需的 `MCP_EGRESS_PROXY_URL` 与 `MCP_EGRESS_PROXY_ADMIN_TOKEN`；env 文件权限为 `0600`，Provider 环境不得继承 admin token；
- launcher 使用 `set -a` 导出配置，并以 `--managed-node` 启动 daemon。

生产 Compose 仍由本目录的网络拓扑负责创建 proxy 和 restricted network。应用 Compose 不得创建 PostgreSQL、Redis 或 RabbitMQ；这些依赖继续使用 `../docker-helm.dofe.ai` 的共享服务。

## 5. 市场发布与连接流程

工作区管理员在“应用市场 -> MCP 服务”选择“添加 MCP 服务”，填写：

- 服务名、slug、不可变 semver 和类别；
- transport；Streamable HTTP 填写 HTTPS endpoint 与额外 allowed hosts，managed stdio 填写已安装入口命令；
- declared tools、逐工具风险和默认批准集合；
- 非密钥字符串配置 schema、密钥字段和数据域；
- 可选文档地址。

工作区自建 release 固定为 `workspace_private + high risk`。发布只创建目录 release，不会自动连接 Runtime。管理员随后选择在线且 MCP eligible 的 Runtime，填写配置/密钥、批准工具并确认高风险访问，系统才创建 connection 并排队验证。

## 6. 运维检查

```bash
# 节点配置
grep -E 'DOFE_AGENT_MANAGED_NODE|MANAGED_RUNTIME_DOCKER_NETWORK|MCP_EGRESS_ENFORCE' \
  "$DOFE_AGENT_DAEMON_STATE_DIR/daemon.env"

# Runtime 私有安装目录
find "$DOFE_AGENT_DAEMON_STATE_DIR/managed-runtimes" -path '*/home/.local/bin/*' -type f

# bridge gateway（应为具体 IPv4，不能是 0.0.0.0）
docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$MANAGED_RUNTIME_DOCKER_NETWORK"

# 容器确认 HOME/PATH；不要打印凭据环境变量
docker inspect <runtime-container> --format '{{json .Config.Env}}' | \
  grep -E '/dofe-home|PATH='
```

常见失败应保持 fail closed：

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `managed_runtime.docker_network_required` | 未配置隔离网络 | 更新 daemon env 并重启节点 |
| `managed_runtime.docker_network_not_isolated` | 使用 default/bridge/host/none | 改为用户自定义网络 |
| `managed_runtime.docker_network_gateway_unavailable` | daemon 无法 inspect 网络 | 检查 Docker 权限和网络是否存在 |
| `managed_runtime.docker_network_gateway_invalid` | gateway 不是具体 IPv4 | 修复 Docker IPAM，不回退 `0.0.0.0` |
| `managed_runtime.mcp_egress_network_required` | enforce 模式未接 restricted network | 先完成 Compose egress 部署 |
| `mcp.managed_stdio_endpoint_invalid` | stdio release 不是单一已安装入口名 | 使用 `stdio://<entrypoint>`，禁止路径和参数 |
| `mcp.managed_stdio_environment_invalid` | stdio 配置试图覆盖保留环境变量 | 仅声明受控的大写业务变量 |

## 7. 验收底线

- 两个 Runtime 安装同名 CLI 时，home 与 `.local/bin` 必须互不相同；
- Runtime 容器重建后，已安装 CLI 仍可执行；
- managed stdio 必须从目标 Runtime 私有 `.local/bin` 启动，Docker stdin 保持打开且网络为 `none`；
- CLI 安装计划 JSON 不得出现 `/dofe-home` 或 daemon 宿主机路径；
- managed Provider 获得的 MCP URL 不得是 `127.0.0.1`，gateway 监听地址不得是 `0.0.0.0`；
- task bundle、Provider env、Runtime HOME 和日志均不得出现 MCP plaintext secret；
- proxy 故障、policy 失配、session 撤销后均不得回退直连；
- 市场空目录必须为管理员提供“添加 MCP 服务”入口，成员只读。
