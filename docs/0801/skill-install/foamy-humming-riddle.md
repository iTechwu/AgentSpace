# Skill-Install 物化器与运行器实现计划

## 背景

控制面已经能创建 Skill 安装计划、入队 `prepare` 操作，并暴露 claim/start/complete/fail 路由。Daemon 目前只负责认领这些操作并立即以 `skill_installation.remote_execution_not_implemented` 失败。为满足 M1，Remote Runtime 必须真正下载不可变 artifact、校验完整性、检查声明组件（依赖、脚本、CLI/MCP 能力），并把可验证证据回传给控制面。

## 目标

1. Daemon 能把认领的 artifact 物化到 Runtime 本地目录：TOS 使用短期签名 URL，本地部署使用本地存储回退。
2. Daemon 在接收物化结果前校验每文件 sha256、路径安全以及根 artifact digest。
3. Daemon 对物化后的 artifact 运行轻量组件校验：
   - `dependency`：lock 项存在且带版本。
   - `script`：文件存在、可执行，并按扩展名/shebang 做语法检查（Shell / Node / Python）。
   - `cli`/`mcp`：manifest 中声明了对应 capability。
4. Daemon 通过现有 complete 路由上报 `componentStatuses` 作为证据；失败则使用明确错误码调用 fail。
5. 工作目录按 `(workspaceId, installationId, operationId)` 隔离，操作结束后清理，并防止路径遍历。

## 本轮不实现

- 真实包管理器依赖解析/安装。
- 网络可达 MCP/CLI 服务的健康检查。
- 断点续传 / 部分下载协议（本轮使用简单 HTTP GET，续传后续补充）。
- Service catalog 准入或托管节点生命周期。

## 关键改动文件

### 领域 / 控制面

- `packages/domain/src/skill-package.ts`
  - 给 `SkillInstallationOperationFile` 增加可选 `downloadUrl` 与 `storedPath`，让 Daemon 能下载每个文件。
  - 给 `ClaimedSkillInstallationOperation` 增加 `manifestJson?: string`，让 Daemon 能重新计算并校验根 digest。
- `packages/services/src/skills/installations.ts`
  - 在 `resolveClaimedSkillInstallationOperationSync` 中读取每个文件的 `ContentBlobRecord`，通过 `createAttachmentStorageClient().createReadUrl` 生成签名读取 URL，并保留 `storedPath` 作为本地回退。
  - 新增辅助函数 `createContentBlobReadUrlSync(workspaceId, sha256)`。
- `packages/services/src/skills/skill-artifacts.ts`
  - 导出 `SkillArtifactManifest`、`SkillArtifactManifestFile` 与 `computeArtifactDigest`，供 Daemon 复用完全一致的 digest 算法。

### Daemon worker

新增目录 `packages/daemon/src/skill-install/`：

- `artifact-materializer.ts`
  - `materializeSkillInstallationArtifact(operation, targetDir)`：
    - 创建 `targetDir`。
    - 对 `operation.files` 中每个文件，优先使用 `downloadUrl`（fetch）下载；缺失时按 `storedPath` 本地路径读取。
    - 校验每文件 sha256。
    - 归一化路径、拒绝遍历、写入文件。
    - 对 `0755` 文件使用 `chmodSync` 保留可执行位。
    - 根据 `operation.manifestJson` 与文件 sha256 重新计算根 digest，并与 `operation.artifactDigest` 比对。
    - 返回 `path -> sha256` 映射及安全摘要。
  - fetch 使用 AbortController 超时，并按声明的 `size` 做尺寸守卫。
- `component-verifier.ts`
  - `verifySkillInstallationComponents(operation, artifactDir)`：
    - 解析 manifest JSON。
    - 对每个 component：
      - `dependency`：manifest 中声明且有版本 → ready。
      - `script`：文件存在、可执行、语法检查通过 → ready。
      - `cli`/`mcp`：manifest 声明 capability → ready；否则 blocked。
    - 包完整性优先校验；完整性失败则所有组件标为 `failed`。
  - `runScriptSyntaxCheck(filePath, interpreter)`：带超时子进程，不继承环境密钥，捕获并脱敏输出。
- `operation-worker.ts`
  - `executeSkillInstallationOperation(client, config, operation)`：
    - 调用 `client.startSkillInstallationOperation`。
    - 使用新增辅助函数 `getDaemonSkillInstallWorkDirPath` 计算 daemon state 下的工作目录。
    - 物化 → 校验 → 以 `componentStatuses` 调用 complete。
    - 任何错误以稳定错误码调用 fail。
    - `finally` 中清理工作目录（除非调试环境变量保留）。

### Daemon 接入

- `packages/db/src/storage-paths.ts`
  - 新增 `getDaemonSkillInstallWorkDirPath(stateDir, { workspaceId, installationId, operationId })`。
- `packages/daemon/src/remote-daemon.ts`
  - 将 `executeRemoteSkillInstallationOperation` 的 fail-fast 占位逻辑替换为调用新 worker 的 `executeSkillInstallationOperation`。

### 测试

- `packages/daemon/src/skill-install/artifact-materializer.test.ts`
  - 通过本地存储物化有效 artifact，断言文件内容、mode、根 digest 一致。
  - 缺失 blob / 错误 digest / 路径遍历均干净失败。
- `packages/daemon/src/skill-install/component-verifier.test.ts`
  - 脚本可执行与语法检查通过/失败。
  - 依赖 lock 检查。
  - cli/mcp capability 检查。
- 如有需要，更新 `packages/daemon/src/daemon-client.test.ts` 中受 claim payload 变化影响的断言。
- 运行 `pnpm --filter dofe-agent-daemon run types` 与相关测试。

## 验证步骤

1. `pnpm --filter @dofe-agent/domain run types`
2. `pnpm --filter @dofe-agent/services run types`
3. `pnpm --filter dofe-agent-daemon run types`
4. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/skill-install/artifact-materializer.test.ts`
5. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/skill-install/component-verifier.test.ts`
6. `node --env-file-if-exists=.env --experimental-strip-types --test packages/daemon/src/daemon-client.test.ts`
7. `node --env-file-if-exists=.env --experimental-strip-types --test packages/services/src/skills/installations.test.ts`
8. `node --env-file-if-exists=.env --experimental-strip-types --test packages/services/src/skills/import.test.ts`

## 已确认决策

1. **脚本语法检查范围**：Shell（`sh -n`）、Node（`node --check`）、Python（`python -m py_compile`）。
2. **本地回退路径**：Daemon 通过 `storedPath` 与 `resolveAttachmentRuntimeConfig` 解析本地 blob 路径；TOS 路径使用签名 URL。
3. **依赖校验深度**：本轮仅检查 lock 项是否带版本；真实包管理器安装延后。

请先审阅本计划。确认后我会按上述顺序开始实现。
