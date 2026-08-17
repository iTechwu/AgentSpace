// runtime 镜像引用单点收敛（构建/版本漂移治理）：此前 5 处各自内联
// `MANAGED_RUNTIME_IMAGE_TAG?.trim() || "latest"`，生产漂移静默发生。
// 生产（NODE_ENV=production）未显式锁定 tag 时回落 latest 并打告警；
// MANAGED_RUNTIME_IMAGE_TAG 支持完整 digest（形如 sha256:...）。
const FALLBACK_IMAGE_TAG = "latest";

export function resolveManagedRuntimeImageTag(): string {
  const pinned = process.env.MANAGED_RUNTIME_IMAGE_TAG?.trim();
  if (pinned) return pinned;
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[managed-runtime] MANAGED_RUNTIME_IMAGE_TAG 未设置，回落 :latest——生产环境应锁定不可变 tag/digest",
    );
  }
  return FALLBACK_IMAGE_TAG;
}

export function buildManagedRuntimeImage(provider: string): string {
  return `dofe/agent-runtime-${provider}:${resolveManagedRuntimeImageTag()}`;
}
