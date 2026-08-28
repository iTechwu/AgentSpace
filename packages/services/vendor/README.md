# vendored 依赖

## xlsx-0.20.3.tgz

- **来源**：`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（SheetJS 官方分发改到自有 CDN 后 npm registry 停留在 0.18.5，0.20.x 只能走 CDN tarball）
- **sha512**：`a0b0eade3c3b01c2ea2966f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`
- **锁定原因**：pnpm 对 URL 形态的 tarball 依赖不在 lockfile 记录 integrity hash，每次 `pnpm install` 都重新信任 CDN 当下返回的字节（3.3-9 供应链锁定）。vendored 后 `file:` 依赖由 pnpm 计算并固定 integrity，install 不再触网、构建可离线复现。
- **升级方式**：从上列 URL 下载新版本 → 覆盖/新增本目录文件 → 更新本文件哈希 → `package.json` 改指新文件 → `pnpm install`。
- **校验方式**：`shasum -a 512 xlsx-0.20.3.tgz` 与上对比。
