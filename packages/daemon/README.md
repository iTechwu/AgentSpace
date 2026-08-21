# dofe-agent-daemon

`dofe-agent-daemon` 是 DofeAgent remote daemon 的独立可分发产物。

在产品定位上，它不是一个孤立的运维组件，而是 DofeAgent 作为“创始人团队数字执行系统”的远程执行底座：数字员工要持续推进跨天任务，必须依赖可独立部署、可远程接入、可安全回收产物的执行层。

它只包含远程 daemon 运行时所需的最小代码：

- daemon HTTP client
- input bundle 解包
- output bundle 打包
- provider CLI 执行 glue code
- 日志、PID、轮询、重试、优雅退出

除了 CLI 入口，包内现在还暴露了一个很小的 library surface，专门给仓库内外的 server-side 调用方复用 daemon HTTP client：

```ts
import { HttpDaemonClient } from "dofe-agent-daemon/daemon-client";
```

构建后对应的运行时产物是 `dist/index.js` 和 `dist/daemon-client.js`。当前这条 surface 只承诺 `HttpDaemonClient` 与它依赖的 daemon API 类型；remote daemon 运行时、provider glue code 等仍然只通过 CLI 入口消费。

它承担的核心角色是：

- 把远端机器接入 DofeAgent 工作区
- 为 long-horizon agent 提供独立执行环境
- 把运行时产物安全回收并写回正式工作流

它不依赖：

- DofeAgent 仓库 checkout
- `Target.md`
- `apps/web`
- `packages/db`
- `packages/services`

## 要求

- Node.js `>=24.19.0`（以 `package.json` 的 `engines.node` 为准）
- 已安装至少一种 provider CLI：`codex`、`claude`、`agy`（Antigravity）、`gemini`（legacy）、`opencode`、`openclaw`、`nanobot`、`hermes`
- `serverUrl`
- `daemonToken`
- `DOFE_AGENT_PROVIDER_ACCOUNT_ID` when the workspace has a configured Provider Account; this identifies the one billing and credential profile permitted for the runtime.

可选的 provider model/env 覆盖：

- `CLAUDE_MODEL`
- `ANTIGRAVITY_MODEL`
- `GEMINI_MODEL`
- `OPENCODE_MODEL`
- `OPENCLAW_PROFILE`
- `NANOBOT_MODEL`
- `NANOBOT_CONFIG` / `NANOBOT_CONFIG_PATH`
- `HERMES_MODEL`
- `HERMES_INFERENCE_MODEL`

## 安装

在仓库内打包：

```bash
cd packages/daemon
pnpm pack
```

`pnpm pack` 前会自动构建 `dist/cli.js`，发布产物运行的是编译后的 JS，不再依赖 `node --experimental-strip-types` 去执行 `node_modules` 里的 TypeScript 源码。

在远端机器安装：

```bash
pnpm add --global ./dofe-agent-daemon-<version>.tgz
```

## 使用

```bash
dofe-agent-daemon start \
  --foreground \
  --server-url "https://your-dofe-agent-domain" \
  --daemon-token "adt_xxx" \
  --daemon-id "daemon-prod-01" \
  --device-name "prod-daemon-host-01" \
  --runtime-name "Remote Agent" \
  --task-timeout "43200000" \
  --state-dir "$HOME/.dofe-agent-daemon"
```

`--task-timeout`/`DOFE_AGENT_TASK_TIMEOUT_MS` 用于 long-horizon 任务。当前默认值是 12 小时，避免 daemon 在 20 分钟左右提前中断跨天执行。

Claude Code runtime 可以由已登录 Claude Code 的用户启动，也可以通过 Provider Account 的节点本地凭据文件提供认证。服务器场景若用 root 启动，认证文件必须属于 root 的 runtime profile；daemon 任务命令会以 root 权限执行。

Provider Account 只保存 secret/config 的引用，不保存 API key。部署 runtime 时由节点侧密钥系统解析该引用，并仅挂载到这一 Provider 的独立 auth/config volume；不要在同一个 daemon/runtime 中切换 Provider Account。

当前内置 resolver 支持节点本地 `file://` 引用。引用文件是 JSON：`environment` 用于 Provider 的 BASE URL、API key 等环境变量，`files` 用于认证或 profile 文件。daemon 会把文件写到 `${DOFE_AGENT_DAEMON_STATE_DIR}/provider-accounts/<account-id>` 并将该目录作为 provider 子进程的 `HOME`，从而避免不同团队共用 Claude/OpenClaw/Codex 的认证目录。

## Provider 说明

- `codex`：继续沿用 `codex exec` 非交互模式
- `claude`：使用 `claude -p --output-format stream-json --input-format stream-json`，prompt 通过 stdin 传入
- `antigravity`：通过 AgentRouter 调用 `agy -p ... --cwd ...` 的 prompt-mode CLI；检测时优先使用 `agy`，并兼容 `antigravity` wrapper。设置 `ANTIGRAVITY_MODEL` 时会映射到 `--model`；已有 session id 时会映射到 `--conversation`
- `gemini`：保留为 legacy CLI one-shot fallback，供仍可访问 Gemini CLI 的用户使用
- `opencode`：通过 AgentRouter 调用 `opencode run --format json`，支持 JSON event 归一化、session 传递、timeout/non-zero/empty-response diagnostics；如果设置了 `OPENCODE_MODEL`，daemon 会映射到 `--model`
- `openclaw`：OpenClaw execution path 是 AgentRouter-only。provider-runtime 只组装 `AgentRouterRunRequest`，不能直接 spawn OpenClaw。当前通过 `openclaw agents add --workspace ...` 建立临时 agent，再用 `openclaw agent --local --json --message ...` 执行；OpenClaw 2026.3.3 的 `agent --help` 未暴露显式 `--model` 参数，所以 per-task model hint 通过 `OPENCLAW_MODEL` 注入
- `nanobot`：当前走 `nanobot agent -m ... -w ...` 的 one-shot 模式；如果设置了 `NANOBOT_MODEL`，daemon 会映射到 `NANOBOT_AGENTS__DEFAULTS__MODEL`
- `hermes`：通过 AgentRouter 调用 `hermes -z ...` 的 headless 文本模式（不带 `--yolo`）；检测时优先使用 `hermes`，并兼容 `hermes-agent` wrapper。当前支持 `HERMES_MODEL` / `HERMES_INFERENCE_MODEL` 映射到 `--model`，未设置时沿用 Hermes 本机默认配置；暂不支持 Hermes 原生 session resume 或 structured events

注意：

- `opencode` / `openclaw` / `nanobot` 各自还有更长期驻留的 server/gateway/serve 形态；当前 daemon 集成优先接通的是最容易嵌入现有 task/workDir 模型的 headless CLI 路径，其中 OpenCode 与 OpenClaw 已收口到 AgentRouter，NanoBot 仍保留 legacy provider runtime
- `openclaw` 与 `nanobot` 如果需要更细粒度 JSON/SSE 事件流，后续可继续收口到它们的 gateway/serve API

OpenClaw profile/model contract：

1. runtime metadata 中的 `openClawProfile` / `openClawModel`（传给 adapter 时会转换为 `DOFE_AGENT_OPENCLAW_*_OVERRIDE`）
2. task / AgentRouter request 的 `model`
3. `OPENCLAW_PROFILE` / `OPENCLAW_MODEL`
4. OpenClaw profile 默认 model

OpenClaw health/preflight：

- daemon heartbeat 会把 OpenClaw `providerHealth` 写入 runtime metadata；runtime online 不代表 provider usable
- daemon task 执行前会在 AgentRouter OpenClaw adapter 内检查 task-local `agent/auth-profiles.json` 和 `agent/models.json`
- broken preflight 会快速失败，并返回统一 provider error，例如 `provider.profile_missing` 或 `provider.model_unavailable`
- standalone `agent-router run --harness openclaw --cwd /tmp ...` 不要求 task-local files，可用于直接 smoke native CLI

OpenClaw troubleshooting：

- `provider.cli_missing`：确认 `openclaw` 在 daemon 用户的 `PATH`
- `provider.profile_missing`：确认 daemon 用户有 OpenClaw profile，且 task workDir 包含 `agent/auth-profiles.json`
- `provider.auth_invalid`：重新登录或刷新 OpenClaw/OpenRouter profile，检查 daemon 继承的 env
- `provider.model_unavailable`：确认 `OPENCLAW_MODEL` 或 profile 默认 model 在当前 auth profile 下可用
- `provider.session_invalid`：旧 session/conversation/agent 不存在；provider-runtime 会清理 task output 并自动开启新会话
- `provider.tool_missing` / `provider.tool_unauthorized` / `provider.tool_permission_denied`：检查 `dofe-agent output`、CLI-Hub app 是否在 PATH 且已授权
- `provider.protocol_parse_failed`：OpenClaw stdout/stderr 不符合 JSON event 预期；查看 provider diagnostic tail

## Sandbox provider

sandbox 当前只有 `local` 一个 provider（`LocalSandbox`，daemon 本地 `workDir` 执行，兼容现有 input/output bundle 流程）。

历史上的 Cube scaffold（仅 lifecycle、`exec()` 未接数据面）已于 2026-08-16 随 commit `bbc935f6` 移除，沙箱收口为 local-only；如需恢复远端沙箱，从 git 历史找回并补齐 exec data plane 后再评估（另见 TODO README 已放弃项 46）。

查看帮助：

```bash
dofe-agent-daemon help
```

## AgentRouter MVP

`agent-router` 是同包发布的轻量跨 harness CLI，用来直接验证 Claude Code、Codex CLI、Antigravity CLI、OpenCode、OpenClaw、Hermes Agent 的原生 headless 调用与统一结果 contract。daemon 的 Claude Code、Codex CLI、Antigravity CLI、OpenCode、OpenClaw、Hermes Agent task execution 已经通过 AgentRouter 执行；DofeAgent task queue、runtime-output、workspace skills 和 Web UI 仍由 daemon 外层流程处理。Gemini、NanoBot 暂时保留旧 provider runtime 路径。

AgentRouter 工作机制图见仓库根目录 `README.md`。


```bash
agent-router harnesses
agent-router detect
agent-router run --harness claude --cwd /workspace/project "summarize this repo"
agent-router run --harness codex --cwd /workspace/project --model gpt-5.1 "fix tests"
agent-router run --harness antigravity --cwd /workspace/project --model "Gemini 3.5 Flash" "summarize this repo"
agent-router run --harness opencode --cwd /workspace/project --model openrouter/openai/gpt-4.1 "summarize this repo"
agent-router run --harness openclaw --cwd /workspace/project --mode medium "review this diff"
agent-router run --harness hermes --cwd /workspace/project "summarize this repo"
agent-router run --harness claude --json-events "write a plan"
```

`--json-events` 输出 JSONL：先输出 normalized router events，最后输出 `{ "type": "result", ... }`。
Hermes Agent 第一版没有 native JSON event stream，AgentRouter 会把 stdout 归一为最终 `outputText`，并通过统一 diagnostic contract 返回非零退出、超时和空响应。
