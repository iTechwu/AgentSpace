# Skill Runner 实施与验收

> 状态：代码闭环完成，真实 Linux managed-node E2E 待执行
>
> 日期：2026-08-03

## 1. 已实施范围

脚本入口不再作为原始可执行文件暴露给 Provider。控制面从任务冻结的 installation snapshot 生成 `skillRunnerEntrypoints`，包含 Skill/installation/artifact/entrypoint/runtime/file hash；Provider 投影把批准的 executable 替换为稳定 shell stub，未知 executable 降为 `0444`。

daemon 为每个任务创建 Unix socket broker 和 `0500` launcher。managed Provider 已将 `/workspace/.dofe-runtime/skill-runner-bin` 加入容器 PATH，launcher 通过工作目录内 socket 请求 daemon，避免 sibling 容器无法访问 daemon loopback，也不开放网络端口。

每次调用前，broker 验证 Runtime cache 目录只读、`.cache-complete` 存在、entrypoint 非符号链接/不可写且 SHA-256 与冻结 manifest 一致。随后以参数数组调用 Docker，不经过 shell。

Runner 容器固定策略：

- image 必须是 `repo@sha256:<64 hex>`；Node/Python/Bash 分开配置。
- `--read-only --network none --cap-drop ALL --security-opt no-new-privileges`。
- UID/GID `65532:65532`，PID 64、内存 256 MiB、CPU 0.5、默认 60 秒且最长 10 分钟。
- artifact、task workspace 与 installation dependency env 只读；只允许 `/output` 写入。
- stdout/stderr 聚合上限 64 KiB，请求 64 KiB，参数最多 64 个且单参数最多 8 KiB。
- 宿主执行只保留 Docker 所需的最小环境，不传 Provider credential 或 Skill env。

## 2. 安装与更新

安装验证器在脚本语法检查后解析 runtime image。缺镜像、tag 引用、未知脚本 runtime 均使脚本组件 `blocked`。运维先批准并预拉取三类镜像 digest，再更新 managed-node 环境；CI reconciler 会校验格式、拉取镜像并把 digest 写入每个 workspace 节点 env。

升级 Runner 镜像不改变 Skill artifact。以新 digest 重建 managed node 后执行 smoke，稳定后回收旧镜像；异常时恢复上一组 digest 并重建。任务仍由 installation snapshot 固定 artifact、dependency env 与 release lock。

## 3. 自动化证据

| 合约 | 测试 |
| --- | --- |
| 容器隔离、digest、参数预算、依赖只读挂载 | `packages/daemon/src/skill-runner.test.ts` |
| 缺镜像阻断安装、runtime/语法检查 | `packages/daemon/src/skill-install/component-verifier.test.ts` |
| snapshot 到 Runner manifest 与 executable hash | `packages/services/src/skills/installations.test.ts` |
| 原始脚本不进入 Provider、stub/mode 正确 | `packages/services/src/skills/injection.test.ts` |
| dependency env metadata/release-lock fail-closed | `packages/daemon/src/skill-install/task-environment.test.ts` |
| managed Provider 获得 task runner PATH 且无 Docker socket | `packages/daemon/src/provider-credentials.test.ts` |

## 4. 生产门禁

在真实 Linux managed node 上安装含 Node、Python、Bash entrypoint 的复合 Skill，并保存以下证据：

```text
[ ] 三类 Runner image inspect 的 RepoDigest 与配置一致
[ ] managed Provider 内可发现稳定 dofe-skill-* 命令并通过 Unix socket调用
[ ] npm require / Python import 使用冻结 installation dependency env 成功
[ ] 网络、Provider HOME/credential、Docker socket、workspace 写入均失败
[ ] 只有 runtime-output/skill-runs 子目录可写且可被输出协议收集
[ ] cache sentinel、entrypoint hash、dependency metadata 任一篡改均 fail-closed
[ ] timeout、输出超限、非零退出产生结构化失败且不泄漏环境变量
[ ] daemon/task 重试清理 socket/launcher/output，继续使用同一 snapshot
```

本工作站不执行 Jenkins 或测试环境部署。上述结果必须由指定 Linux 测试环境的非 Jenkins 禁令冲突流程或经授权的发布流水线保存；在证据完成前，脚本能力不得视为生产放行。
