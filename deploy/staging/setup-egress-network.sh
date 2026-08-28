#!/usr/bin/env bash
# Create the isolated Docker network the managed runtime must run on, with the
# attestation label the daemon and the egress release gate both enforce
# (dofe.managed-egress=restricted), plus optional egress filtering.
#
# The verify:managed-runtime-egress gate:
#   - inspects `docker network inspect <name>` and requires label
#     dofe.managed-egress=restricted (and rejects bridge|default|host|none);
#   - runs a probe container on the network that asserts MODELS_GATEWAY_BASE_URL
#     is reachable and every MANAGED_RUNTIME_BLOCKED_EGRESS_{URLS,IPS,PROXY_URLS}
#     is NOT reachable.
#
# Two modes:
#   MODE=internal (default, local): --internal network → no external route at all.
#     The models gateway MUST be a container on this network (point
#     MODELS_GATEWAY_BASE_URL at it, e.g. http://models:3000/api). Blocked hosts
#     are unreachable by construction; the gate passes as long as the gateway
#     container is reachable. Fully reproducible on a laptop.
#
#   MODE=firewall (deployed models at model.local.dofe.ai): labelled network
#     WITH external route, plus host iptables rules that allow only the models
#     gateway host and drop the blocked list. Requires sudo / privileged host.
#     Production should use Kubernetes NetworkPolicy or a cloud firewall instead
#     — this is a dev/staging stand-in.
set -euo pipefail

NETWORK="${MANAGED_RUNTIME_DOCKER_NETWORK:-dofe-models-egress}"
MODE="${STAGING_EGRESS_MODE:-internal}"
LABEL_KEY="dofe.managed-egress"
LABEL_VALUE="restricted"

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "==> Network $NETWORK already exists; reusing."
else
  case "$MODE" in
    internal)
      echo "==> Creating INTERNAL network $NETWORK (no external egress; models must be a container on this network)."
      docker network create --internal --label "$LABEL_KEY=$LABEL_VALUE" "$NETWORK" >/dev/null
      ;;
    firewall)
      echo "==> Creating labelled network $NETWORK (external route; apply firewall separately)."
      docker network create --label "$LABEL_KEY=$LABEL_VALUE" "$NETWORK" >/dev/null
      ;;
    *)
      echo "Unknown STAGING_EGRESS_MODE='$MODE' (expected: internal|firewall)" >&2
      exit 1
      ;;
  esac
fi

# Verify the label is present (the gate checks it).
actual="$(docker network inspect "$NETWORK" --format '{{ index .Labels "$LABEL_KEY" }}' 2>/dev/null || true)"
if [ "$actual" != "$LABEL_VALUE" ]; then
  echo "!! Network $NETWORK is missing label $LABEL_KEY=$LABEL_VALUE (got: '$actual')." >&2
  echo "   Delete it and re-run: docker network rm $NETWORK" >&2
  exit 1
fi
echo "==> Label OK: $LABEL_KEY=$LABEL_VALUE"

if [ "$MODE" = "firewall" ]; then
  GATEWAY_HOST="${MODELS_GATEWAY_HOST:-model.local.dofe.ai}"
  SUBNET="$(docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
  cat <<EOF
==> Firewall mode: network $NETWORK subnet=$SUBNET
    Allowed egress host: $GATEWAY_HOST
    Apply host iptables to allow only $GATEWAY_HOST and drop the rest, e.g.:
      GW_IP=\$(getent hosts $GATEWAY_HOST | awk '{print \$1}')
      sudo iptables -I DOCKER-USER -s $SUBNET -d \$GW_IP -j ACCEPT
      sudo iptables -I DOCKER-USER -s $SUBNET -j DROP
    (Production: prefer Kubernetes NetworkPolicy or a cloud egress firewall.)
EOF
fi

echo "==> Network ready: $NETWORK"
