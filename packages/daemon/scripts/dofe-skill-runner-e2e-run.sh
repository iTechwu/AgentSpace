#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# --preflight：只跑前置校验（Linux 节点、三个 digest 钉死的 Runner 镜像变量、镜像
# 本地存在、docker 可用、iptables 可读写），通过即退出 0，不执行真实 e2e。供部署
# 工作流在「停服前」fail-fast：变量只放在仓库 .env（本脚本的 shell 不会加载 .env，
# 仅 node 子进程通过 --env-file 读取）或镜像未就绪、runner 无 iptables 权限时，在
# 服务还在运行时就退出 1，而不是停服、构建之后才触发回滚。
PREFLIGHT=0
if [[ "${1:-}" == "--preflight" ]]; then
  PREFLIGHT=1
fi

preflight_checks() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Skill Runner release gate must run on a Linux managed node." >&2
    return 1
  fi

  local DOCKER_BIN="${DOFE_SKILL_RUNNER_DOCKER_BIN:-docker}"
  for key in DOFE_SKILL_RUNNER_NODE_IMAGE DOFE_SKILL_RUNNER_PYTHON_IMAGE DOFE_SKILL_RUNNER_BASH_IMAGE; do
    local value="${!key:-}"
    if [[ ! "$value" =~ @sha256:[a-fA-F0-9]{64}$ ]]; then
      echo "$key must be set to repo@sha256:<64-hex>." >&2
      echo "  这些变量必须导出在 runner 的 shell 环境里（由 deploy/daemon/ensure-ci-managed-nodes.sh" >&2
      echo "  写入受管节点 env 文件）；仅放在仓库 .env 不生效——本脚本 shell 不会加载 .env。" >&2
      return 1
    fi
    if ! "$DOCKER_BIN" image inspect "$value" >/dev/null 2>&1; then
      echo "$key image not present locally: $value" >&2
      echo "  部署前需先拉好 digest 钉死的镜像（见 deploy/daemon/ensure-ci-managed-nodes.sh）。" >&2
      return 1
    fi
  done

  if ! "$DOCKER_BIN" version >/dev/null 2>&1; then
    echo "docker 不可用（runner 用户无 docker 权限或 daemon 未运行）。" >&2
    return 1
  fi

  # system-dependency.e2e-real-docker.test.ts 在受管节点 HOST 上落地并读取真实
  # iptables 规则（DOCKER-USER 链），需要 CAP_NET_ADMIN/root。生产策略用默认
  # iptables 二进制（DOFE_AGENT_IPTABLES_BIN 仅供测试注入），故按默认校验即可。
  if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables 不在 PATH 上；egress 门禁需在 host 上落地 iptables 规则。" >&2
    return 1
  fi
  if ! iptables -S >/dev/null 2>&1; then
    echo "iptables 不可读写（需要 CAP_NET_ADMIN/root）；egress 门禁在 host 上落地规则会被拒。" >&2
    return 1
  fi
}

preflight_checks

if [[ "$PREFLIGHT" -eq 1 ]]; then
  echo "Skill Runner egress preflight OK（runner 变量 / 镜像 / docker / iptables 均就绪）。" >&2
  exit 0
fi

export DOFE_AGENT_RUN_SKILL_RUNNER_E2E=1
NODE_BIN="${DOFE_AGENT_NODE:-$(command -v node)}"

# Every REAL Docker release-gate file. Both must pass; a failure in one still
# runs the other so the gate reports the full picture instead of stopping early.
FILES=(
  src/skill-runner.e2e-real-docker.test.ts
  src/skill-install/system-dependency.e2e-real-docker.test.ts
)
rc=0
for file in "${FILES[@]}"; do
  echo "→ Skill Runner real-Docker release gate: $file" >&2
  "$NODE_BIN" --env-file-if-exists=../../.env --experimental-strip-types --test --test-concurrency=1 "$file" || rc=$?
done
exit "$rc"
