# GitHub 仓库 Skill 自动发现与导入优化

> 状态：核心缺陷已修复，产品与工程验收基线已确定
>
> 日期：2026-08-14
>
> 目标：用户粘贴常见的 GitHub 仓库主页链接时，AgentSpace 能确定性地发现正确的 `SKILL.md`、锁定不可变版本、校验完整 Skill 包，并给出可理解的成功或失败结果。

## Problem Statement

用户通常从 README、社区帖子或 GitHub 首页复制仓库链接，例如：

```text
https://github.com/KKKKhazix/human-writing
```

实际 Skill 包可能位于子目录：

```text
https://github.com/KKKKhazix/human-writing/tree/main/human-writing
```

要求用户自行寻找 `tree/<branch>/<path>` 链接会增加理解成本，也容易复制到错误层级。平台此前还存在两个实现问题：

1. Web 调用传入 `workspaceId` 时，位置参数被误当成文件相对路径前缀，导致已发现的 `SKILL.md` 被保存为 `<workspaceId>/SKILL.md`，最终错误提示“Imported GitHub skill must contain SKILL.md”。
2. 每个文件都通过 GitHub Contents API 下载，公共 IP 很容易耗尽匿名 API 配额；目录已经发现后仍可能在下载第一个文件时失败。

产品需要同时保证：

- **正确性**：不能猜测并安装错误目录，不能混入 Skill 目录外的仓库文件。
- **一致性**：一次导入的所有文件必须来自同一个 commit SHA。
- **完整性**：`SKILL.md`、引用、脚本、资产和配置必须作为一个包统一校验。
- **可解释性**：无 Skill、多 Skill、限流、权限和包校验失败必须有不同提示和补救动作。
- **可用性**：公共仓库减少 GitHub API 请求；私有仓库和稳定生产导入使用工作区凭据。

## Solution

### 用户体验

GitHub 导入框统一接受以下链接：

| 输入形态 | 示例 | 行为 |
| --- | --- | --- |
| 仓库主页 | `https://github.com/owner/repo` | 自动解析默认分支并发现唯一 Skill |
| Skill 目录 | `https://github.com/owner/repo/tree/main/path/to/skill` | 直接以该目录为包根目录 |
| SKILL.md 页面 | `https://github.com/owner/repo/blob/main/path/SKILL.md` | 导入该文件；若需关联文件，应使用目录链接 |
| Raw SKILL.md | `https://raw.githubusercontent.com/owner/repo/main/path/SKILL.md` | 导入该文件 |
| `.git` 仓库链接 | `https://github.com/owner/repo.git` | 归一化为仓库主页处理 |

用户粘贴仓库主页后不需要填写分支或目录。系统显示“正在解析默认分支”“正在查找 Skill”“正在校验包”“正在保存”四个阶段，最终展示解析出的来源目录和锁定 commit。

### 确定性发现规则

仓库主页导入按以下顺序执行：

1. 只接受 `https://github.com/<owner>/<repo>` 形态，拒绝未知主机、额外业务路径和 URL 中的凭据。
2. 解析仓库默认分支，并将该 ref 锁定为 40 位 commit SHA。
3. 在该 commit 的递归 tree 中查找文件名大小写等价于 `SKILL.md` 的 blob。
4. 如果仓库根目录存在唯一 `SKILL.md`，包根目录为仓库根目录。
5. 如果全仓只有一个嵌套 `SKILL.md`，包根目录为该文件所在目录。
6. 如果没有候选，拒绝导入并提示仓库不包含 Skill。
7. 如果存在多个候选，拒绝自动选择；返回候选目录，要求用户选择或粘贴具体 tree URL。
8. 如果 GitHub 返回截断 tree，拒绝自动选择；不能把“不完整结果中唯一”误判为“全仓唯一”。

自动发现不使用“目录名与仓库名相同”“最短路径”“第一个结果”等启发式规则。正确安装优先于少一次交互。

### 包边界与下载

发现包根目录后，只导入该目录及其后代文件：

```text
repository
├── README.md                    # 不导入
├── assets/                      # 不导入
└── human-writing/               # Skill 包根目录
    ├── SKILL.md                 # 必须
    ├── scripts/                 # 导入
    ├── references/              # 导入
    ├── agents/                  # 导入
    └── VERSION                  # 导入
```

下载必须满足：

- 目录发现和 ref 解析使用 GitHub API，并携带工作区 GitHub 凭据（如果已配置）。
- 文件内容优先使用 `raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/<path>`，正常路径不再为每个文件消耗 Contents API 配额。
- 自动发现后的 raw 下载固定为最多 4 路并发，并设置 5 秒请求上限，避免多文件 Skill 串行下载超过 Server Action 代理窗口。
- raw 网络失败、超时或返回非成功状态时，可回退到 `contents/<path>?ref=<commit-sha>`；回退仍锁定同一 SHA、携带工作区凭据并计入统一请求预算。
- 所有文件 URL 使用已解析 commit SHA，不使用可变分支名。
- 文件路径先归一化并检查 traversal、绝对路径、非法分隔符和嵌套深度。
- 请求数、文件数、单文件大小和总解压大小继续使用统一 Skill source budget。
- 任一文件失败时整个导入失败，不持久化部分 Skill、部分 artifact 或导入事件。

### Skill 分析与校验

下载完成后按统一 package authority 处理：

1. 确认包根目录存在且只使用一个根级 `SKILL.md`。
2. 解析 frontmatter 中的 `name`、`description` 和平台支持字段。
3. 解析依赖声明、Runtime 要求、脚本入口、MCP/CLI/受管服务能力和配置需求。
4. 对所有文件计算 path-sorted SHA-256，并生成不可变 artifact digest。
5. 校验 manifest、文件类型、可执行 mode、来源预算和安全策略。
6. 保存原始仓库 URL、owner、repo、原始 ref、解析路径、commit SHA 和警告。
7. 冲突策略只影响工作区 Skill 名称或候选版本，不得改变来源文件或跳过校验。

### 正确性与可用性的边界

“保证正确安装”表示平台要么安装经过验证的唯一包，要么明确拒绝；不表示在 GitHub 不可用、权限不足或配额耗尽时强行成功。

匿名 GitHub API 具有共享 IP 配额，生产环境应使用最小权限的工作区 GitHub credential 或 GitHub App installation token。没有凭据时仍允许公共仓库导入，但必须：

- 尽量复用一次递归 tree，避免重复目录请求。
- 文件内容走 immutable raw URL。
- 识别 `403`、`X-RateLimit-Remaining: 0` 和 `X-RateLimit-Reset`。
- 返回“GitHub API 配额已用尽”，展示可重试时间，并提供“配置 GitHub 凭据”动作。
- 不得降级为读取可变分支、抓取 HTML 猜目录或跳过 commit 锁定。

## User Stories

1. 作为工作区管理员，我希望粘贴 GitHub 仓库主页就能导入唯一 Skill，以便无需理解仓库目录结构。
2. 作为工作区管理员，我希望系统显示实际解析出的 Skill 目录和 commit，以便确认来源正确。
3. 作为工作区管理员，我希望多个 Skill 的仓库让我明确选择目录，以免安装错误内容。
4. 作为工作区管理员，我希望没有 `SKILL.md` 时得到清楚提示，以便更换链接或联系作者。
5. 作为工作区管理员，我希望 GitHub 限流时看到重试时间和凭据配置入口，而不是笼统的 500 错误。
6. 作为安全管理员，我希望所有文件锁定到同一个 commit SHA，以免扫描后内容被分支更新替换。
7. 作为安全管理员，我希望导入只包含 Skill 根目录下的文件，以免仓库其他内容进入执行面。
8. 作为私有仓库用户，我希望工作区凭据用于所有 GitHub API 和 raw 请求，以便完整导入授权内容。
9. 作为运维人员，我希望导入失败不留下半成品记录，以便重试和审计结果一致。
10. 作为研发人员，我希望根 URL、tree、blob、raw 使用同一 package validator，以免不同入口产生不同安全语义。
11. 作为研发人员，我希望函数使用具名参数传递下载上下文，以免 workspace、路径和预算再次错位。
12. 作为产品负责人，我希望记录各阶段耗时和失败码，以便衡量成功率并定位 GitHub 可用性问题。

## Implementation Decisions

- 最高测试接缝保持为“从 URL 导入工作区 Skill”，所有 UI 和来源形态最终进入这一服务契约。
- GitHub 仓库根链接先解析为明确的 Skill directory pointer，再进入现有目录导入与 artifact 持久化链路。
- directory pointer 必须包含 owner、repo、原始 ref、Skill path 和 resolved SHA。
- 文件下载上下文使用具名 options，包含 relative prefix、是否要求根级 `SKILL.md`、共享预算和 workspace ID；禁止继续扩展位置型可选参数。
- 仓库自动发现只接受零、唯一、多个三态，不引入隐式评分算法。
- recursive tree 的 `truncated` 状态属于不确定结果，必须 fail-closed。
- 文件下载优先使用 commit SHA 的 raw URL；仅在 raw 不可用时回退到同一 SHA 的 Contents API，不允许回退到可变分支。
- 自动发现后的文件下载使用 4 路有界并发；不得使用无上限 `Promise.all`。
- 正常 raw 路径中的二进制文件按 bytes 读取，不经过 UTF-8 转换；Contents API 回退按协议解码 base64，`SKILL.md` 最终执行严格 UTF-8 解码。
- 来源检查更新只比较默认分支最新 SHA，不重新发现 Skill 目录；仓库后来新增第二个 Skill 不应让已安装来源失去更新能力。
- 不新增数据库字段；解析路径和 commit 已进入来源配置与 artifact provenance。
- 导入错误应映射为稳定产品错误码，而不是直接展示英文内部异常。

建议错误码：

| 错误码 | 用户提示 | 补救动作 |
| --- | --- | --- |
| `skill.github.url_invalid` | 无法识别 GitHub 链接 | 粘贴仓库、tree、blob 或 raw 链接 |
| `skill.github.not_found` | 仓库或目录不存在 | 检查权限和链接 |
| `skill.github.no_skill` | 仓库中未找到 SKILL.md | 使用包含 Skill 的仓库或目录 |
| `skill.github.multiple_skills` | 仓库包含多个 Skill | 选择候选目录 |
| `skill.github.tree_truncated` | 仓库过大，无法安全自动定位 | 粘贴具体 tree URL |
| `skill.github.rate_limited` | GitHub API 配额已用尽 | 到时重试或配置凭据 |
| `skill.github.unauthorized` | GitHub 凭据无权访问 | 更新工作区凭据 |
| `skill.github.file_download_failed` | Skill 文件下载失败 | 重试并查看失败文件 |
| `skill.package.invalid` | Skill 包校验失败 | 查看具体校验项 |

## Testing Decisions

测试只验证外部行为，不断言私有辅助函数：

### 服务层

- 仓库根 URL + `workspaceId` 能发现唯一嵌套 Skill 并保留正确相对路径。
- 非 `main` 默认分支能解析并锁定 SHA。
- 根级唯一 `SKILL.md` 能把仓库根作为包根。
- 零个候选返回 `no_skill`。
- 多个候选返回 `multiple_skills`，且不写入 Skill 或 artifact。
- `truncated: true` 返回 `tree_truncated`。
- Contents API 文件请求被限流时，immutable raw 文件下载仍可完成。
- raw 传输失败时，5 秒内切换到 SHA 锁定的 Contents API，并继续执行相同的路径、大小和总包预算校验。
- 多文件 raw 下载并发度大于 1 且不超过 4。
- tree、blob、raw URL 保持兼容。
- 私有仓库的 API 和 raw 请求都携带工作区 credential。
- 任一 raw 文件失败、超限或路径非法时无部分持久化。
- 更新检查不重新扫描仓库树。

### Web 层

- GitHub 来源提示包含仓库主页链接。
- 提交原始 URL 和冲突策略，不在前端猜分支或目录。
- 成功后弹窗关闭、列表出现 Skill、反馈包含解析目录和 commit 摘要。
- 多候选展示选择界面；选择后以具体目录重新提交。
- rate limit、权限、无 Skill 和包校验错误显示不同中文反馈与动作。

### 浏览器验收

使用隔离浏览器和测试管理员账号执行：

1. 打开 Skill 页面并记录控制台、失败请求和基线截图。
2. 粘贴 `https://github.com/KKKKhazix/human-writing`。
3. 确认请求成功，反馈不是 500，列表出现 `human-writing`。
4. 打开 Skill 详情，确认来源目录为 `human-writing`、ref 为 `main`、resolved SHA 为 40 位。
5. 确认 `references/`、`scripts/`、`agents/` 和 `VERSION` 已进入文件清单。
6. 确认页面无 console error/warning、无 unnamed control、无布局溢出。
7. 再次导入，验证 rename/reject/replace/skip 四种冲突策略。

## Acceptance Criteria

- [ ] 用户仅粘贴截图中的仓库主页即可成功导入 `human-writing` Skill。
- [ ] 保存的 Skill 根目录是 `human-writing`，不是仓库根目录或 workspace ID 前缀。
- [ ] artifact 中存在根级 `SKILL.md` 及目录内全部受允许文件。
- [ ] provenance 保存原始 URL、`main`、`human-writing` 和 40 位 commit SHA。
- [ ] 单次导入的文件内容只从该 commit SHA 下载。
- [ ] 目录型导入传入 workspace ID 时测试通过。
- [ ] GitHub 文件内容正常路径不逐个消耗 Contents API 配额；只有 raw 不可用时才按预算回退。
- [ ] 多 Skill、无 Skill、截断 tree 均不会错误安装。
- [ ] 浏览器真实导入成功，Server Action 不返回 500。
- [ ] 控制台、网络、视觉和可访问性复测无未处理问题。
- [ ] 服务测试、Web 测试、类型检查和 lint 通过。

## Metrics And Operations

建议记录以下指标，不记录 token 或 URL 中的敏感参数：

- `skill_import_total{provider,outcome,error_code}`
- `skill_import_duration_ms{provider,stage}`
- `skill_github_discovery_candidates`
- `skill_github_api_requests_per_import`
- `skill_github_raw_fallback_total`
- `skill_github_rate_limit_remaining`
- `skill_import_artifact_bytes`
- `skill_import_file_count`

告警建议：

- 15 分钟内 GitHub 导入 5xx 比例超过 5%。
- `rate_limited` 在单工作区连续出现 3 次。
- 导入成功但 artifact 缺少根级 `SKILL.md`（理论上必须为零）。
- 同一来源 URL 在同一 commit 产生不同 artifact digest（必须立即调查）。

## Rollout Plan

1. 修复 workspace ID 参数错位并增加真实调用形态测试。
2. 将文件下载切换为 immutable raw URL，保留现有预算与凭据。
3. 在测试环境对公共单 Skill 仓库、私有仓库和多 Skill 仓库执行浏览器验收。
4. 上线稳定错误码、候选目录选择和 rate limit 补救入口。
5. 增加 GitHub 请求缓存或按 workspace 的 GitHub App 凭据，降低共享出口 IP 配额风险。
6. 观察一周导入成功率、P95 时延和错误码分布后移除旧提示。

## Out Of Scope

- 自动执行仓库 README 中的安装命令或任意 shell。
- 在多个候选中根据名称、Stars、目录深度或 README 文案自动猜测。
- 在 GitHub API 不可用时改为可变分支下载。
- 支持 GitHub Enterprise；需要单独的 host allowlist、凭据和 API 基址模型。
- 绕过 Skill package validator 导入非 Agent Skills 目录。
- 从本工作站触发 Jenkins 或测试环境部署。

## Further Notes

- 本方案优先保证“不会安装错”，其次才是“少一次点击”。
- 对多 Skill monorepo，后续最佳体验是在弹窗中展示候选目录列表；在该 UI 完成前，具体 tree URL 是明确且安全的补救路径。
- 公共匿名 GitHub API 配额是外部可用性约束。生产级稳定性必须依赖工作区凭据、GitHub App 或受控缓存，不能仅依赖共享出口 IP。
- 实施与文档必须同步更新；任何新增 GitHub URL 形态都必须进入同一 SHA 锁定、预算和 artifact authority。
