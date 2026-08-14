# 发布前人工预检清单

> 建立日期：2026-08-14。
> 适用范围：`agentspace.dofe.ai`。仓库当前**没有自动化测试 CI**（`.github/workflows/` 只有 `deploy-production.yml` 部署工作流），下列校验必须由发布者在发布前**人工执行**并确认通过。

## 1. TOS 预签名回归（必跑）

自实现 V4 预签名器（`packages/services/src/attachments/tos-signer.ts`，已移除 `@volcengine/tos-sdk`）的**活服务器基线**。签名规范的任何改动若只通过单元测试（golden vector）不够，必须跑真实 TOS 集成测试：

```bash
pnpm --filter @dofe-agent/services run test:tos
```

- 执行文件：`packages/services/src/attachments/storage-tos.integration.test.ts`，5 个用例。
- 依赖**真实 TOS 凭据**（本地 `.env` 注入，见 `TOS_*` 环境变量），因此未纳入无凭据的 CI。
- 预期：5/5 通过。失败说明签名器与服务端规范不符，**禁止发布**。
- golden vector 单测（`tos-signer.test.ts`，8 向量，无凭据）只能证明签名算法自洽，**不能**替代本项。

## 复核与升级

- 若未来引入带凭据的 CI（如 GitHub Actions secrets 配好 TOS 凭据），应把本清单第 1 项迁移为定时或发布前自动门禁，届时更新本文档。
- 新增「未被自动化覆盖、但发布前必须人工确认」的项时，追加到本清单。
