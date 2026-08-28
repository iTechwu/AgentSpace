# CLI 新增与来源治理

## 1. 先统一领域语言

| 概念 | 定义 | 例子 |
| --- | --- | --- |
| Source | 谁提供目录元数据、由谁负责信任与更新 | official、verified partner、community、workspace private、skill dependency |
| Package | 一个可发现的 CLI 产品身份 | `chrome-devtools-mcp` |
| Release | Package 的不可变版本及安装声明 | `chrome-devtools-mcp@1.6.0` + digest |
| Installation | 某个 release 在某个 Runtime 上的实例 | Runtime A 已安装 1.6.0 |
| Binding | CLI 与 Skill 或 managed stdio MCP 的依赖关系 | MCP release 依赖 entrypoint |

当前 `runtime_app_catalog_item` 同时承担 Package 和可变 release 的角色，是来源和版本治理继续扩展的主要限制。产品上必须先区分这些概念，即使数据库迁移分阶段完成。

## 2. 当前如何添加

### 2.1 添加 CLI-Anything harness

当前没有 AgentSpace 页面入口。维护者需要按上游规范向 CLI-Anything 仓库提交 PR，将条目加入 `registry.json`。上游合并后，AgentSpace 管理员刷新目录即可同步。

适合：可公开、愿意接受上游治理的 CLI harness。

不适合：内部 CLI、固定企业版本、私有 registry、需要立即上线的工具。

### 2.2 添加公共 CLI

当前同样需要向 CLI-Anything 的 `public_registry.json` 提交 PR，或由 AgentSpace 开发者在服务端代码中写入固定条目。后者目前用于官方 MCP 的 Runtime 组件。

问题是两类条目都落入 `clihub_public`，UI 无法区分“上游社区收录”和“平台固定、经过验证”。

### 2.3 添加 Skill 依赖

Skill 依赖经审批后生成 `skill_dependency` 安装计划。它的可见范围和生命周期应跟随 Skill/安装版本，不应被展示为普通公共 CLI。

### 2.4 添加 MCP

工作区管理员可在 MCP Tab 点击“添加 MCP 服务”，发布 `workspace_private` release；发布不会自动连接 Runtime。管理员随后选择 Runtime、填写配置和密钥、批准工具并发起验证。

## 3. 目标来源分类

建议 CLI 与 MCP 共用一套用户可理解的来源等级，底层保留不同 transport/安装策略：

| 产品标签 | 稳定 key | 谁可发布 | 默认信任 | 可见范围 |
| --- | --- | --- | --- | --- |
| 平台官方 | `official` | 平台发布流程 | 通过平台验证 | 全平台 |
| 已验证合作方 | `verified_partner` | 合作方 + 平台审核 | 通过合作方与 release 审核 | 全平台或指定组织 |
| 社区目录 | `community` | 已接入的只读来源适配器 | 仅目录收录，不代表可安装 | 全平台 |
| 工作区私有 | `workspace_private` | 工作区管理员 | 高风险，逐 release 审核 | 当前工作区 |
| Skill 依赖 | `skill_dependency` | Skill 安装流程 | 继承 Skill release lock | 绑定 Skill/工作区 |

UI 必须同时展示：来源标签、发布者、版本、审核状态、最后同步时间。来源不等于安全等级，仍需独立风险与兼容性判断。

## 4. 目标“添加 CLI”流程

### 4.1 入口

管理员在“CLI 应用”页头看到 `+ 添加 CLI`。点击后先选择目的，而不是直接填写技术字段：

1. **从 npm 添加**：输入 package + 固定 semver；
2. **从 PyPI 添加**：输入 package + 固定 version；
3. **导入受管清单**：上传或填写 HTTPS manifest URL；
4. **申请收录公共 CLI**：生成提交信息并跳转上游贡献入口；
5. **添加 stdio MCP**：跳转到组合流程，先发布 CLI release，再发布 MCP release。

首期只实施 1、2、3，并统一发布为 `workspace_private`。

### 4.2 分步表单

```text
1 基本信息 -> 2 安装来源 -> 3 Runtime 预检 -> 4 风险与权限 -> 5 审核发布
```

**基本信息**

- 名称、slug、描述、类别、文档地址；
- entrypoint；
- 可选 Skill 引用；
- 发布者显示名。

**安装来源**

- package manager：npm 或 PyPI；
- 精确版本，不接受 `latest`、范围或通配符；
- registry 必须来自平台 allowlist；
- 服务端解析 tarball/wheel 地址、完整性摘要和许可证信息；
- 浏览器不提交可执行命令。

**Runtime 预检**

- OS/architecture；
- Node/Python/系统依赖；
- 安装网络是否可用；
- entrypoint 冲突；
- 所选 Runtime 预计兼容数。

**风险与权限**

- 是否需要网络、账号、API key、桌面应用或本机服务；
- 安装期允许访问的 registry hosts；
- 任务期网络策略单独声明；
- 高风险原因与管理员确认。

**审核发布**

- 显示规范化安装计划，不显示或执行上游原始 shell；
- 显示 digest、版本、来源、目标可见范围；
- 发布创建不可变 release；
- 发布后进入详情页，不自动安装。

### 4.3 Happy path

```text
管理员选择 npm
  -> 输入 @scope/tool + 2.4.1
  -> 服务端读取 registry metadata
  -> 校验 semver、integrity、entrypoint
  -> 选择 2 个 Runtime 做兼容性预检
  -> 查看风险与受控 argv 计划
  -> 发布工作区私有 release
  -> 在详情页选择 Runtime 并安装
  -> verifyCommands 成功
  -> 可选同步 Skill / 绑定 managed stdio MCP
```

### 4.4 必须覆盖的错误状态

```text
输入 package + version
  -> registry 中不存在该固定版本
  -> 阻断发布
  -> 显示“版本不存在”，保留已填内容
  -> 提供“查看可用稳定版本”动作
```

其他阻断错误：摘要缺失、entrypoint 冲突、registry 不受信、版本被下架、目标 Runtime 不兼容、需要交互式安装、只支持桌面环境。

## 5. 受管 manifest

建议使用结构化 manifest，而不是复用上游 `install_cmd`：

```json
{
  "schemaVersion": 1,
  "name": "internal-search-cli",
  "version": "1.4.2",
  "publisher": "workspace:example",
  "category": "data_analytics",
  "entrypoints": ["internal-search"],
  "artifact": {
    "kind": "npm",
    "package": "@example/internal-search-cli",
    "version": "1.4.2",
    "integrity": "sha512-..."
  },
  "runtime": {
    "os": ["linux"],
    "arch": ["x64", "arm64"],
    "requires": ["node>=20"]
  },
  "permissions": {
    "installHosts": ["registry.example.com"],
    "taskNetwork": "none",
    "secretFields": []
  },
  "skill": {
    "url": "https://docs.example.com/internal-search/SKILL.md",
    "sha256": "..."
  }
}
```

服务端将 manifest 规范化为受控 argv 与验证命令。manifest 本身不能包含 shell、任意 preinstall/postinstall 脚本白名单绕过、宿主机绝对路径或凭据值。

## 6. 新来源适配器

工作区私有 CLI 稳定后，再引入来源适配器。每个适配器至少实现：

```ts
interface CliCatalogSourceAdapter {
  sourceKey: string;
  fetchRevision(): Promise<{ revision: string; fetchedAt: string }>;
  listPackages(cursor?: string): Promise<PackagePage>;
  readRelease(packageId: string, version: string): Promise<ImmutableRelease>;
  verifyProvenance(release: ImmutableRelease): Promise<ProvenanceResult>;
}
```

平台要求：

- 每个来源独立展示同步状态、错误、最后成功时间和缓存 revision；
- 新同步不能静默覆盖已有 release；
- 删除/下架生成明确状态，不直接删除已安装记录；
- 来源故障时继续使用最后成功快照，并在 UI 标记“目录可能已过期”；
- adapter 只能写目录元数据，不能直接触发 Runtime 安装；
- 新来源启用前完成 30 天目录稳定性和安装成功率观察。

## 7. CLI 与 MCP 的组合发布

对于工作区私有 `managed_stdio` MCP，不让管理员手工填写一个假定已存在的命令。目标流程应为：

```text
选择现有 CLI release
  或发布新的工作区私有 CLI release
    -> 选择该 release 的一个 entrypoint
    -> 声明 MCP tools / config / secrets / data domains
    -> 发布 MCP release
    -> 对目标 Runtime 执行 CLI 安装
    -> 安装验证成功后创建 MCP connection
```

这样可以让依赖关系可追踪，也避免 `stdio://local-mcp` 指向未知二进制。

## 8. 迁移建议

1. 先修正 UI source 映射，`skill_dependency` 不再显示为 Public CLI；
2. 为平台固定 Runtime 组件增加 `official` provenance，不再借用 `clihub_public` 身份；
3. 将上游自由文本类别归一化为稳定 taxonomy，同时保留原始类别；
4. 增加 package/release 投影，不立即破坏现有安装表；
5. 增加工作区私有 CLI 发布；
6. 观察指标达标后再开放新的公共 source adapter。
