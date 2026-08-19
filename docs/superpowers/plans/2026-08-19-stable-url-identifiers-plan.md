# 稳定 URL 标识实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让新生成的工作区和有稳定 ID 的实体链接使用 ID，并在旧链接解析成功后自动规范化为 ID URL。

**Architecture:** 保留现有数据库 slug 作为兼容输入，新增共享的工作区规范化和实体引用工具。服务端在工作区上下文边界把旧 slug 重定向到 workspace id；客户端页面在解析旧实体引用后只用 router.replace 更新目标查询参数。优先迁移已有稳定 ID 的 agent、task、document、runtime、workflow run 链接，不改造没有稳定 ID 的 channel/contact 数据模型。

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, Playwright, pnpm.

---

### Task 1: 建立工作区规范路径工具契约

**Files:**
- Modify: apps/web/features/auth/workspace-paths.ts
- Test: apps/web/features/auth/workspace-paths.test.ts

- [ ] 写失败测试：验证 workspace id 路径构建、旧 slug 替换后保留深层路径/query/hash、规范 ID 不重复替换、非法 URI 不抛错。
- [ ] 运行 pnpm --filter @repo/web exec vitest run features/auth/workspace-paths.test.ts，确认因 helper 不存在而失败。
- [ ] 实现 canonicalWorkspacePath(input): string | null。仅在 requestedWorkspaceIdentifier 非空且不同于 workspaceId 时返回编码后的 /w/<id> 路径，保留 pathname、search 和 hash。
- [ ] 重跑同一 Vitest 命令，确认通过。
- [ ] 提交：git add apps/web/features/auth/workspace-paths.ts apps/web/features/auth/workspace-paths.test.ts && git commit -m "新增工作区规范路径工具"。

### Task 2: 服务端旧工作区 slug 重定向到 workspace ID

**Files:**
- Modify: apps/web/app/w/[workspaceSlug]/page.tsx
- Modify: apps/web/app/w/[workspaceSlug]/[...workspacePath]/page.tsx
- Modify: apps/web/features/auth/server-workspace-resolver.ts
- Test: apps/web/features/auth/server-workspace.test.ts

- [ ] 写失败测试：旧 slug 能解析到 context.currentWorkspace.id，页面 mock redirect 后只替换工作区首段；直接访问 ID 不触发 redirect。
- [ ] 运行 pnpm --filter @repo/web exec vitest run features/auth/server-workspace.test.ts features/auth/workspace-paths.test.ts，确认 redirect 断言失败。
- [ ] 在两个 workspace page 入口使用当前请求标识和 resolved workspace id 比较；旧 slug 命中时 redirect 到同模块路径、query 和 hash 的 ID 路径，保持权限和错误分支不变。
- [ ] 重跑同一命令，确认通过且无重定向循环。
- [ ] 提交：git add -A 仅包含本任务文件，git commit -m "兼容旧工作区slug并重定向到ID"。

### Task 3: 建立 agent 引用解析与规范化

**Files:**
- Create: apps/web/features/agents/agent-url-reference.ts
- Test: apps/web/features/agents/agent-url-reference.test.ts
- Modify: apps/web/features/agents/agents-page-client.tsx
- Modify: apps/web/features/channels/channels-page-client.tsx

- [ ] 写失败测试：agent:employeeId、旧记录 id、internalName、唯一展示名的解析优先级；重名展示名不改写；成功旧引用返回 agent:employeeId；新 builder 使用 employeeId。
- [ ] 运行 pnpm --filter @repo/web exec vitest run features/agents/agent-url-reference.test.ts，确认模块不存在导致失败。
- [ ] 实现纯函数 resolveAgentUrlReference(agents, focus) 和 buildAgentFocusReference(employeeId)。匹配顺序固定为记录 id、employeeId、internalName、唯一 name。
- [ ] 替换 agents 页面 resolveFocusedAgentId，并在旧 focus 成功解析且 canonical reference 不同时复制 URLSearchParams 后 router.replace；新入口全部使用 employeeId。
- [ ] 频道跳转优先使用可解析的 agent employeeId，无法映射时保留现有联系人兼容。
- [ ] 运行 pnpm --filter @repo/web exec vitest run features/agents/agent-url-reference.test.ts features/agents/agents-page-client.test.tsx features/channels/channels-page-client.test.tsx。
- [ ] 提交：git add -A 仅包含本任务文件，git commit -m "将agent链接规范化为稳定员工ID"。

### Task 4: 迁移已有稳定 ID 的跨模块链接生成点

**Files:**
- Modify: apps/web/features/search/global-search-dialog.tsx
- Modify: apps/web/features/approvals/approvals-page-client.tsx
- Modify: apps/web/features/task-board/task-board-page-client.tsx
- Modify: apps/web/features/workflows/workflow-list-client.tsx
- Modify: apps/web/features/workflows/workflow-run-client.tsx
- Modify: apps/web/features/runtimes/runtimes-page-client.tsx
- Test: 对应已有的 Vitest 测试文件

- [ ] 为 task、document、runtime、workflow run 增加失败断言，确认 URL 使用记录 ID；明确 channel/contact 仍使用当前兼容键。
- [ ] 运行相关 Vitest 文件，确认新增断言失败。
- [ ] 使用 buildWorkspacePath 和 URLSearchParams 替换手写展示名拼接，不改变 API 路径语义。
- [ ] 重跑相关 Vitest 文件，确认通过。
- [ ] 提交：git add -A 仅包含本任务文件，git commit -m "迁移跨模块链接到稳定ID"。

### Task 5: 迁移工作区 UI 生成器并清理纯中文 SSO slug 回退

**Files:**
- Modify: apps/web/features/dashboard/workspace-frame.tsx
- Modify: apps/web/features/dashboard/workspace-switcher.tsx
- Modify: apps/web/features/auth/sso-workspaces.ts
- Test: apps/web/features/auth/sso-workspaces.test.ts
- Test: apps/web/features/dashboard/workspace-frame.test.tsx

- [ ] 写失败断言：工作区切换、侧边栏和工作区模块 href 使用 workspace.id；纯中文 SSO scope 的新 slug 使用 ASCII workspace-<suffix> 回退；已有旧中文 slug 仍可解析。
- [ ] 运行 pnpm --filter @repo/web exec vitest run features/auth/sso-workspaces.test.ts features/dashboard/workspace-frame.test.tsx，确认失败。
- [ ] 修改 workspaceHref、切换入口和相关 prefetch 使用 currentWorkspace.id；切换 action 继续接受 id 或 slug。仅修改新 SSO slug 生成的纯中文回退，不迁移已存储 slug。
- [ ] 重跑同一命令，确认通过。
- [ ] 提交：git add -A 仅包含本任务文件，git commit -m "让工作区导航使用稳定ID"。

### Task 6: 分层回归、发现问题后继续 TDD 修复

**Files:**
- Modify: 仅限受失败测试直接暴露的实现和测试文件。

- [ ] 运行受影响 Vitest：pnpm --filter @repo/web exec vitest run features/auth/workspace-paths.test.ts features/auth/server-workspace.test.ts features/auth/sso-workspaces.test.ts features/agents/agent-url-reference.test.ts features/agents/agents-page-client.test.tsx features/channels/channels-page-client.test.tsx features/dashboard/workspace-frame.test.tsx。
- [ ] 运行 pnpm --filter @repo/web typecheck，确认类型检查通过。
- [ ] 运行 pnpm --filter @repo/web exec playwright test e2e/workspace-navigation.spec.ts --workers=2，验证旧中文链接进入后收敛到 ID、刷新无循环、后退行为正常。
- [ ] 若发现问题，先新增能复现问题的失败测试，再做最小修复；先重跑最小失败命令，再重跑完整受影响套件和浏览器回归。
- [ ] 运行 git diff --check 和 git status --short，确认不包含用户已有未提交改动。
- [ ] 每个独立 follow-up 使用 git add -A 后提交中文 commit message；不执行 Jenkins 或部署。
