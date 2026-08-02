# Skill Runner 实施与验收

> 状态：代码闭环完成，真实 Linux managed-node E2E 待执行
>
> 日期：2026-08-03

## 1. 已实施范围

脚本入口不再作为原始可执行文件暴露给 Provider。控制面从任务冻结的 installation snapshot 生成 `skillRunnerEntrypoints`，包含 Skill/installation/artifact/entrypoint/runtime/file hash；Provider 投影把批准的 executable 替换为稳定 shell stub，未知 executable 降为 `0444`。

daemon 为每个任务创建 Unix socket broker 和 `0500` launcher。managed Provider 已将 `/workspace/.dofe-runtime/skill-runner-bin` 加入容器 PATH，launcher 通过工作目录内 socket 请求 daemon，避免 sibling 容器无法访问 daemon loopback，也不开放网络端口。

launcher 名称协议 revision 2 使用受限可读前缀、原始 Skill/entrypoint 稳定哈希和 Skill 后缀，长度固定受控。manifest 在导入时拒绝规范化后重复的 entrypoint id；broker 对任务内重复 key 和最终命令名再次 fail-closed，禁止 launcher 文件静默覆盖。该协议变化已提升 `providerCompatibilityRevision`，因此 release lock 不会跨版本误复用。

每次调用前，broker 验证 Runtime cache 目录只读、`.cache-complete` 存在、entrypoint 非符号链接/不可写且 SHA-256 与冻结 manifest 一致。随后以参数数组调用 Docker，不经过 shell。

Runner 容器固定策略：

- image 必须是 `repo@sha256:<64 hex>`；Node/Python/Bash 分开配置。安装验证和每次 broker 启动均执行本地 `docker image inspect`，缺失时组件/能力立即阻断。
- broker 启动时一次性冻结 image digest 与 timeout；单次任务内不再读取变化后的环境变量。`docker run --pull never` 禁止任务执行期间隐式拉取。
- `--read-only --network none --cap-drop ALL --security-opt no-new-privileges`。
- UID/GID `65532:65532`，PID 64、内存 256 MiB、CPU 0.5、默认 60 秒且最长 10 分钟。
- artifact、task workspace 与 installation dependency env 只读；只允许 `/output` 写入。`/output` 实际绑定 daemon 状态目录中的随机一次性目录并显式设为 `0777`，不直接绑定 Provider 可写的 task workspace；执行后 daemon 只生成带路径、大小、mode 和 SHA-256 的文件 manifest，任务 launcher 校验 digest 后在 Provider 文件系统命名空间中以临时文件和原子 rename 发布到 `runtime-output/skill-runs/<entrypoint>`。宿主 daemon 不再向 Provider 可控路径写文件。
- stdout/stderr 聚合上限 64 KiB，请求 64 KiB，参数最多 64 个且单参数最多 8 KiB。
- 每次调用使用随机且受限的 Docker 容器名。超时、输出超限和 broker 关闭都会执行并等待 `docker rm -f`；只有确认容器退出后才删除短时配置与私有输出。清理失败时保留 daemon 私有目录并返回结构化错误，禁止把“Docker CLI 已退出”误当成脚本容器已退出。
- broker 默认每个任务最多并发运行 2 个 Runner，可通过 `DOFE_SKILL_RUNNER_MAX_CONCURRENCY` 下调或上调但硬上限为 32；超过时返回 `skill_runner.concurrency_limit_exceeded`，不创建输出/config 或容器。
- 输出发布最多 1000 个目录项、目录深度 32、单文件 20 MiB、总计 64 MiB；私有输出发现符号链接或特殊文件、launcher 目标路径发现链接/非普通文件、manifest digest 不符或预算越界时整次调用失败，临时目录和临时文件始终清理。
- entrypoint 的 `configKeys` 最多 64 个且必须匹配大写环境键格式。daemon 将声明键从 Provider 环境中剥离，只把声明且已解析的值写入随机短时 JSON，通过只读 secret mount 暴露；Provider 环境、Docker 参数、workspace 和未声明键中不出现值，调用完成立即删除。
- 宿主执行只保留 Docker 所需的最小环境，不传 Provider credential 或 Skill env。

## 2. 安装与更新

安装验证器先解析并确认本地存在 runtime image，再在同一 digest-pinned Runner 镜像中执行语法检查；不再用宿主 Node/Python/Bash 代替目标运行环境。检查容器同样固定 `--pull never`、只读 artifact、无网络、非 root、资源上限；入口路径逃逸或符号链接在启动检查容器前阻断。缺镜像、tag 引用、未知脚本 runtime 或镜像内语法检查失败均使脚本组件 `blocked`。运维先批准并预拉取三类镜像 digest，再更新 managed-node 环境；CI reconciler 会校验格式、拉取镜像并把 digest 写入每个 workspace 节点 env。

升级 Runner 镜像不改变 Skill artifact。以新 digest 重建 managed node 后执行 smoke，稳定后回收旧镜像；异常时恢复上一组 digest 并重建。任务仍由 installation snapshot 固定 artifact、dependency env 与 release lock。

## 3. 自动化证据

| 合约 | 测试 |
| --- | --- |
| 容器隔离、digest、参数预算、依赖只读挂载、私有可写输出、symlink 拒绝、超时容器强制删除与配置清理顺序 | `packages/daemon/src/skill-runner.test.ts` |
| entrypoint 规范化唯一、broker key/命令冲突拒绝 | `manifest-schema.test.ts`、`skill-runner.test.ts` |
| configKeys snapshot、Provider/Runner 环境分区、按键筛选、只读短时挂载与清理 | `installations.test.ts`、`skill-runner.test.ts` |
| 任务级并发拒绝、超时容器强制删除 | `skill-runner.test.ts` |
| Linux 真实 Node/Python/Bash、冻结依赖、网络/写入/secret/socket 负面验证 | `skill-runner.e2e-real-docker.test.ts`、`scripts/dofe-skill-runner-e2e-run.sh` |
| 未配置/本地缺镜像阻断安装、镜像内 runtime/语法检查、路径逃逸与符号链接拒绝 | `packages/daemon/src/skill-install/component-verifier.test.ts` |
| snapshot 到 Runner manifest 与 executable hash | `packages/services/src/skills/installations.test.ts` |
| 原始脚本不进入 Provider、stub/mode 正确 | `packages/services/src/skills/injection.test.ts` |
| dependency env metadata/release-lock fail-closed | `packages/daemon/src/skill-install/task-environment.test.ts` |
| managed Provider 获得 task runner PATH 且无 Docker socket | `packages/daemon/src/provider-credentials.test.ts` |

## 4. 生产门禁

在真实 Linux managed node 上安装含 Node、Python、Bash entrypoint 的复合 Skill，并保存以下证据：

```text
[ ] 三类 Runner image inspect 的 RepoDigest 与配置一致
[ ] 删除本地 Runner image 后安装与新任务能力均立即 blocked，任务执行不会触发 pull
[ ] managed Provider 内可发现稳定 dofe-skill-* 命令并通过 Unix socket调用
[ ] npm require / Python import 使用冻结 installation dependency env 成功
[ ] 网络、Provider HOME/credential、Docker socket、workspace 写入均失败
[ ] 仅声明的 configKeys 可从 DOFE_SKILL_CONFIG_FILE 读取，Provider env 与 docker argv 不含值，文件在调用结束后消失
[ ] Runner UID 65532 可写 daemon 私有 `/output`，Provider 工作目录不作为 Docker 可写挂载源
[ ] 产物仅发布到 runtime-output/skill-runs，symlink/特殊文件/文件数与容量越界均 fail-closed
[ ] cache sentinel、entrypoint hash、dependency metadata 任一篡改均 fail-closed
[ ] timeout、输出超限、非零退出产生结构化失败且不泄漏环境变量
[ ] timeout、输出超限或 broker 关闭后 `docker ps -a` 不存在对应随机容器，短时配置只在容器删除确认后清理
[ ] daemon/task 重试清理 socket/launcher/output，继续使用同一 snapshot
```

本工作站不执行 Jenkins 或测试环境部署。上述结果必须由指定 Linux 测试环境的非 Jenkins 禁令冲突流程或经授权的发布流水线保存；在证据完成前，脚本能力不得视为生产放行。
