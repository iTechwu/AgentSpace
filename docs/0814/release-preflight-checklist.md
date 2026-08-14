# 发布前人工预检清单

> 建立日期：2026-08-14。最近修订：2026-08-14（补记 Skill Runner egress 两段式门禁与环境要求）。
> 适用范围：`agentspace.dofe.ai`。

## 门禁性质（必读）

本清单是**发布工程约定 / 人工纪律**，**不是**自动化门禁。当前部署链路的真实情况：

- `deploy-production.yml` 在 `push` 到 `main`（以及 `workflow_dispatch`）时自动部署到生产节点。
- 该工作流**自动校验**三件事，任一失败都会阻断上线（前两项失败直接退出，服务仍在运行旧版本；第三项失败触发回滚）：
  1. **停服前预检**：`dofe-skill-runner-e2e-run.sh --preflight`——校验 Linux 节点、三个 digest 钉死的 Runner 镜像变量、镜像已在本地、docker 可用、iptables/ip6tables/iptables-save/ip6tables-save 可读写（需 CAP_NET_ADMIN）；若启用了 IPv6 v4-only 豁免，还会以与门禁相同的规则预校验审批人、绝对到期日与 ≤30 天有效期，配置非法在停服前即失败。预检在独立的**候选提交 worktree**（`git worktree add --detach <tmp> "$after"`）中执行，保证预检对象与将要上线的代码严格一致；worktree 注册了 EXIT trap，任何退出路径（job 超时 / 取消 / `set -e` 中断）都会注销临时目录与 worktree 元数据。
  2. 构建成功（`pnpm run build`）。
  3. **Skill Runner egress 发布门禁**：`dofe-skill-runner-e2e-run.sh` 在构建后、`start_service` 前跑真实 Docker + 真实 iptables 验收（两个文件：`skill-runner.e2e-real-docker.test.ts` 覆盖 Runner 容器隔离 / digest / config-socket 清理 / 缓存与依赖元数据篡改 fail-closed / 超时结构化错误码；`system-dependency.e2e-real-docker.test.ts` 覆盖 egress 双层强制——DNS 毒化下真实域名不得解析（含正向 pin 基线）、DOCKER-USER 链放行 IP 仅 :443、非放行 IP / DoH / IPv6 全部 DROP）。失败即回滚到正在运行的版本。
- 该工作流**不运行**任何单元/集成测试，包括本清单第 1 项的 `test:tos`。仓库也没有独立的测试 CI。
- 因此：除非发布者**在 push 到 `main` 之前**自行执行并通过本清单，否则下列校验会被跳过、部署照常进行。

换句话说，“失败禁止发布”目前只靠发布者自觉，没有任何机器强制。要把它变成真正的自动门禁，见文末「升级为自动门禁」。

### Skill Runner egress 门禁的环境要求（部署节点必须满足，否则预检 fail-closed）

- 三个 Runner 镜像变量 `DOFE_SKILL_RUNNER_{NODE,PYTHON,BASH}_IMAGE` 必须是 `repo@sha256:<64-hex>` 且镜像已预拉取到本地（`--pull never`，不在部署窗口拉取）。来源由工作流 env `DOFE_SKILL_RUNNER_ENV_FILE=/home/AgentSpace/.env` 显式指定——与 daemon 运行时 `--env-file` 同一份 `.env`；runner 环境显式导出的值优先。注意 `ensure-ci-managed-nodes.sh` 只把变量写进各受管节点容器的 `node.env`，**不会**导出到部署 runner shell，不能假设 shell 自带。
- 部署 runner 用户需有 docker 权限；节点 `iptables` 在 PATH 上且可读写（host 上落地 DOCKER-USER 链需要 CAP_NET_ADMIN/root）。
- **验收网络必须具备真实 IPv6 出口**：egress 专用 docker 网络以 `--ipv6` 创建（存量网络需 `docker network rm` 后重建），节点需有全局 v6 连通性。门禁以**真实连通性**判定 v6 可用：只有放行正样本（Cloudflare DoH v6 :443 经 `--add-host` pin 后真实 CONNECT）才算可用；仅有全局 v6 地址但没有可路由出口的节点同样判定为不可用（`ipv6GlobalAddr=1, allowedV6443≠0` 会如实上报），落入 fail-closed 或获批豁免分支。可用时要求 v6 放行正样本连通 + v6 deny 探测 DROP + ip6tables 链 DROP 包计数归因。v4-only 豁免是有时限、可审计的运维审批，需**同时**设置三个变量：`DOFE_SKILL_RUNNER_EGRESS_ALLOW_NO_IPV6=1` + `DOFE_SKILL_RUNNER_EGRESS_ALLOW_NO_IPV6_APPROVED_BY=<审批人>` + `DOFE_SKILL_RUNNER_EGRESS_ALLOW_NO_IPV6_UNTIL=YYYY-MM-DD`（绝对到期日，距今 ≤30 天，过期即失效）；豁免生效时门禁输出会记录审批人、到期日及当时的连通性证据（ipv6GlobalAddr/allowedV6443）作为审计痕迹。
- 门禁的 DROP 证据带内核计数器归因：deny 探测超时本身无法区分“我们的链丢弃”与“上游防火墙沉默”，真实 Runner 流量运行期间轮询 `iptables-save -c` / `ip6tables-save -c`，要求本次运行受管链的 DROP 规则包计数 ≥ 探测数。
- 非 Linux 节点直接失败，不转 skip。详见 `docs/0801/skill-install/05-运维服务与版本治理.md` §2.3。

## 1. TOS 预签名回归（约定必跑）

自实现 V4 预签名器（`packages/services/src/attachments/tos-signer.ts`，已移除 `@volcengine/tos-sdk`）的**活服务器基线**。签名规范的任何改动若只通过单元测试（golden vector）不够，必须跑真实 TOS 集成测试：

```bash
pnpm --filter @dofe-agent/services run test:tos
```

- 执行文件：`packages/services/src/attachments/storage-tos.integration.test.ts`，5 个用例。
- 依赖**真实 TOS 凭据**（本地 `.env` 注入，见 `TOS_*` 环境变量），因此未纳入无凭据的 CI。
- 预期：5/5 通过。失败说明签名器与服务端规范不符，**发布者不得 push 到 `main`**——但因部署不自动校验本项，这一条只能由发布者自觉执行。
- golden vector 单测（`tos-signer.test.ts`，8 向量，无凭据）只能证明签名算法自洽，**不能**替代本项。
- 触发时机：只要改动了 `tos-signer.ts`、`storage.ts` 的预签名逻辑，或升级了影响签名计算的依赖，就应在合并到 `main` **之前**本地跑通。

## 升级为自动门禁（待决策）

当前不自动化的原因：本项需要真实 TOS 凭据，仓库 CI 尚未配置对应 secrets。若未来决定把它做成真正的门禁，二选一：

1. 在带凭据的 CI（GitHub Actions secrets 配好 `TOS_*`）里加一个发布前 / 定时 job，失败阻断部署。
2. 将 `deploy-production.yml` 的 `main` push 触发改为 `workflow_dispatch` + 人工审批，把“跑过 test:tos”作为审批前置。

两种方案都需要额外的凭据管理与策略决策，目前**有意延后**；在此之前，本清单的人工纪律是唯一防线。

## 维护

- 新增「未被自动化覆盖、但发布前应人工确认」的项时，追加到本清单，并在「门禁性质」中如实标注它是否被自动校验。
