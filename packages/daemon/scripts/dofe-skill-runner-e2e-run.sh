#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 三个 Runner 镜像变量（digest 钉死）的来源：仓库 .env——与运行时同一份（node 子进程
# 也通过 --env-file 读它）。脚本启动时从这里补齐「尚未在环境中设置」的变量，使 preflight
# 与下方真实 e2e 共用同一个来源；runner 环境里已显式导出的值优先（便于 CI 覆盖）。
#
# 注意：deploy/daemon/ensure-ci-managed-nodes.sh 只把变量写进各受管节点 *容器* 的
# node.env，并不导出到部署 runner 的 shell，因此不能假设 runner shell 自带这些变量。
load_runner_images_from_env() {
  local env_path="${DOFE_SKILL_RUNNER_ENV_FILE:-../../.env}"
  [[ -f "$env_path" ]] || return 0
  local key value
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    case "$key" in
      DOFE_SKILL_RUNNER_NODE_IMAGE|DOFE_SKILL_RUNNER_PYTHON_IMAGE|DOFE_SKILL_RUNNER_BASH_IMAGE)
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        [[ -z "$value" ]] && continue
        [[ -n "${!key:-}" ]] && continue   # 已显式导出的环境值优先，不覆盖
        export "$key=$value"
        ;;
    esac
  done < "$env_path"
}

# --preflight：只跑前置校验（Linux 节点、三个 digest 钉死的 Runner 镜像变量、镜像
# 本地存在、docker 可用、iptables 可读写），通过即退出 0，不执行真实 e2e。供部署
# 工作流在「停服前」fail-fast：变量未提供（.env 与 runner 环境都没有）、镜像未就绪、
# 或 runner 无 iptables 权限时，在服务还在运行时就退出 1，而不是停服、构建之后才回滚。
PREFLIGHT=0
if [[ "${1:-}" == "--preflight" ]]; then
  PREFLIGHT=1
fi

load_runner_images_from_env

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
      echo "  本脚本会自动从仓库 .env 补齐这三个变量（与运行时同一来源）；若仍未设置，请在" >&2
      echo "  .env 中定义它们，或在 runner 环境显式导出以覆盖。ensure-ci-managed-nodes.sh 只把" >&2
      echo "  变量写进各受管节点容器的 node.env，不会导出到部署 runner 的 shell。" >&2
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
