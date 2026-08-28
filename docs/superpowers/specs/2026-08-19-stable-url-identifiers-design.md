# 稳定 URL 标识与旧链接规范化设计

## 背景

当前工作区路由和部分查询参数直接使用可读名称。纯中文 SSO 工作区会生成包含中文的 `slug`，AI 员工聚焦链接也可能使用展示名或内部名。例如：

```text
/w/yootun-all-%E4%BC%98%E6%83%A0%E8%B1%9A-%E5%85%A8%E4%BD%93-87e967/agents
?mode=agent&focus=agent%3AAim+%C2%B7+%E4%BC%98%E6%83%A0%E8%B1%9AAI%E6%94%B6%E8%BD%A6%E5%AE%9A%E4%BB%B7
```

这类 URL 冗长、难以检查，并把可变展示文本当作实体身份。系统已有稳定的工作区 `id`，AI 员工也已有稳定的 `employeeId`，应优先用这些标识生成链接，同时兼容既有收藏和外部引用。

## 目标

- 新生成的工作区 URL 固定使用 `workspace.id`。
- 有稳定 ID 的实体引用使用 ID，不再使用展示名称或内部名称。
- 旧工作区 slug、旧 AI 员工名称等链接继续可访问。
- 旧链接解析成功后立即规范化：路径使用服务端重定向，查询参数使用客户端 `router.replace`。
- 规范化保留模块路径、无关查询参数和 hash，不产生额外浏览历史。
- 测试覆盖新旧格式、循环规避、参数保留和关键页面导航。

## 非目标

- 不迁移或删除数据库中的工作区 `slug`；它仍用于旧链接解析和兼容接口。
- 不为缺少稳定 ID 的 channel、contact 等实体引入新数据表或迁移。
- 不用展示名称的转写结果冒充稳定身份。当前没有稳定 ID 的实体继续沿用既有定位键，后续应在数据模型提供 ID 后单独迁移。
- 不改变页面展示名称、业务权限和模块数据契约。

## 规范 URL 契约

### 工作区路径

规范格式：

```text
/w/<workspace.id>/<module-path>
```

所有已取得完整 `StoredWorkspaceRecord` 的 UI 和服务端代码必须将 `workspace.id` 传给统一路径构建器。现有变量名中的 `workspaceSlug` 可在迁移期间保留，但新接口应使用 `workspaceIdentifier` 或 `workspaceId`，避免继续暗示路径只能使用 slug。

服务端仍通过 `readWorkspaceSync(idOrSlug)` 同时解析 ID 和旧 slug。请求使用旧 slug 且成功解析时，重定向至相同模块路径和查询串，仅替换工作区路径段。规范 ID 请求不得再次重定向。

### 实体查询参数

保留现有带类型引用形式，替换引用值：

```text
focus=agent:<employeeId>
focus=task:<taskId>
document=<documentId>
```

AI 员工是本次明确需要迁移的实体。新链接使用 `employeeId`；解析顺序为：

1. 完整旧记录 ID，例如 `agent:<legacy-key>`；
2. `employeeId`；
3. `internalName`；
4. 展示名称。

匹配成功后，页面选择真实记录，并把 URL 改写为 `focus=agent:<employeeId>`。解析顺序必须保证已有旧记录 ID 不因名称碰撞改变含义。

其他已有稳定 ID 且当前仍用名称生成链接的实体，按同一原则迁移。没有稳定 ID 的实体不在本次虚构 ID；其链接保持兼容，避免扩大数据库改造范围。

## 组件与职责

### 工作区 URL 工具

工作区路径工具负责：

- 从稳定的工作区标识构建编码安全的 `/w/...` 路径；
- 解析路径中的工作区标识；
- 用规范 ID 替换旧标识，同时原样保留模块路径、查询和 hash；
- 对空标识和非法编码提供确定、可测试的结果。

### 服务端工作区规范化

工作区页面上下文成功解析后比较请求标识与 `currentWorkspace.id`。两者不同时执行重定向。该逻辑应集中在共享页面渲染/上下文边界，而不是复制到每个模块页面。

重定向只表达规范地址，不改变权限判断：未认证、无权限、已归档和不存在的工作区继续走现有处理。

### 客户端实体规范化

页面模型或纯函数负责把查询引用解析成：

```ts
{
  selectedId: string | null;
  canonicalReference?: string;
}
```

页面只在 `canonicalReference` 与当前参数不同时调用 `router.replace`。改写时复制当前 `URLSearchParams`，只修改目标参数，保留 `mode`、`tab` 等其他状态并禁用滚动。

所有新跳转使用同一个规范引用构建函数，避免页面继续自行拼接展示名称。

## 兼容与失败处理

- 旧工作区 slug 能唯一解析时重定向至 ID 路径。
- 旧 AI 员工名称或内部名能唯一解析时选中员工并 replace 为 employee ID。
- 查询引用无法解析时不改写，维持现有空态或默认选择。
- 若历史数据出现名称碰撞，稳定 ID 优先；名称兼容只在匹配唯一时生效，避免静默指向错误实体。
- 已是规范格式时不调用 redirect/replace，防止循环和重复渲染。
- URL 解码失败时按无法解析处理，不抛出导致整页 500 的异常。

## 推进范围

1. 盘点并迁移所有 `buildWorkspacePath(workspace.slug, ...)`、`/w/${workspace.slug}` 和工作区切换入口，使新 UI 链接使用 `workspace.id`。
2. 调整工作区页面上下文，在旧 slug 请求成功后统一重定向。
3. 迁移 AI 员工页面、频道跳转、全局搜索等 agent focus 生成点，统一使用 `employeeId`。
4. 逐项检查 task、document、runtime、workflow run 等已有稳定 ID 的链接，保持或收敛到 ID。
5. 对 channel/contact 等无稳定 ID 的引用保留现状，并记录为数据模型后续项。

## 测试策略

### 单元测试

- 工作区 ID 路径构建、解析及旧 slug 规范化。
- 中文 slug 可兼容解析，但新路径生成只使用传入的稳定 ID。
- AI 员工 `employeeId`、旧记录 ID、内部名、展示名均可解析。
- 旧 AI 员工引用得到规范引用；新引用不触发 replace。
- 名称冲突时不进行不确定的兼容改写。
- 查询改写保留无关参数。

### 集成测试

- 工作区页面接收旧 slug 后跳转到 ID 路径，并保留深层模块路径及查询串。
- 工作区切换、侧边栏、全局搜索和跨模块入口都生成 ID 路径。
- agents 页面从旧名称 focus 进入后选中正确员工并 replace 为 employee ID。

### 浏览器回归

- 打开真实旧中文链接，确认页面可访问且地址栏收敛到纯 ID 链接。
- 刷新规范链接，确认无重定向循环。
- 验证 agents、im、knowledge、inbox、task-board、automations 和 runtimes 的主要跳转。
- 验证浏览器后退不会停留在规范化前的 URL。

测试发现问题后，新增能够稳定复现问题的失败测试，再修复并重新执行相关单元、集成和浏览器回归。

## 发布与回滚

本改动不需要数据库迁移，也不删除旧 slug，因此可通过回滚应用代码恢复旧生成行为。部署后应观察 404、工作区解析失败和客户端 replace 循环。根据本机约束，本轮只实施、验证和提交，不执行 Jenkins 或测试环境部署。
