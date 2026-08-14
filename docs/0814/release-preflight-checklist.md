# 发布前人工预检清单

> 建立日期：2026-08-14。最近修订：2026-08-14（澄清门禁性质）。
> 适用范围：`agentspace.dofe.ai`。

## 门禁性质（必读）

本清单是**发布工程约定 / 人工纪律**，**不是**自动化门禁。当前部署链路的真实情况：

- `deploy-production.yml` 在 `push` 到 `main`（以及 `workflow_dispatch`）时自动部署到生产节点。
- 该工作流**只自动校验**两件事：构建成功（`pnpm run build`）、Skill Runner egress 发布门禁（`dofe-skill-runner-e2e-run.sh`）。两者失败都会回滚并阻断上线。
- 该工作流**不运行**任何单元/集成测试，包括本清单第 1 项的 `test:tos`。仓库也没有独立的测试 CI。
- 因此：除非发布者**在 push 到 `main` 之前**自行执行并通过本清单，否则下列校验会被跳过、部署照常进行。

换句话说，“失败禁止发布”目前只靠发布者自觉，没有任何机器强制。要把它变成真正的自动门禁，见文末「升级为自动门禁」。

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
