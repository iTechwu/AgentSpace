#!/usr/bin/env bash
set -euo pipefail

# reconcile-runtime-egress.sh
#
# Idempotently install DOCKER-USER rules that restrict runtime containers to:
#   1. the mcp-egress-proxy on the restricted runtime network;
#   2. configured control-plane and models-gateway endpoints;
#   3. DNS only when explicitly configured;
# and default-drop everything else (IPv4 TCP/UDP, plus IPv6 default drop).
#
# This script is intended to be executed by the managed-node, which holds
# NET_ADMIN and host network namespace.

: "${RUNTIME_SUBNET:?Set RUNTIME_SUBNET, e.g. 172.20.0.0/16}"
: "${PROXY_RUNTIME_IP:?Set PROXY_RUNTIME_IP, e.g. 172.20.0.2}"
: "${CONTROL_PLANE_IPV4:?Set CONTROL_PLANE_IPV4}"
: "${MODELS_GATEWAY_IPV4:?Set MODELS_GATEWAY_IPV4}"

IPTABLES=${IPTABLES:-iptables}
IP6TABLES=${IP6TABLES:-ip6tables}
CHAIN="DOCKER-USER"
OWNED_CHAIN="DOFE-MCP-EGRESS"
OWNED_CHAIN_V6="DOFE-MCP-EGRESS6"

die() {
  echo "$1" >&2
  exit 1
}

ensure_chain() {
  if ! "$IPTABLES" -n -L "$CHAIN" >/dev/null 2>&1; then
    die "iptables chain $CHAIN does not exist; is Docker running on this host?"
  fi
}

comment_for() {
  echo "dofe:mcp-egress:$1"
}

remove_owned_rules() {
  local tool=$1
  local chain=$2
  "$tool" -n -L "$chain" --line-numbers 2>/dev/null \
    | awk '/dofe:mcp-egress/ {print $1}' \
    | sort -rn \
    | while IFS= read -r line; do
        [ -n "$line" ] && "$tool" -D "$chain" "$line"
      done
}

reset_owned_chain() {
  local tool=$1
  local chain=$2
  if "$tool" -n -L "$chain" >/dev/null 2>&1; then
    "$tool" -F "$chain"
  else
    "$tool" -N "$chain"
  fi
}

delete_owned_chain() {
  local tool=$1
  local chain=$2
  if "$tool" -n -L "$chain" >/dev/null 2>&1; then
    "$tool" -F "$chain"
    "$tool" -X "$chain"
  fi
}

install_ipv4_rules() {
  ensure_chain

  # A first-position jump prevents an existing broad ACCEPT in DOCKER-USER
  # from bypassing the runtime policy. All managed rules live in our chain.
  remove_owned_rules "$IPTABLES" "$CHAIN"
  reset_owned_chain "$IPTABLES" "$OWNED_CHAIN"

  "$IPTABLES" -A "$OWNED_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT -m comment --comment "$(comment_for established)"

  "$IPTABLES" -A "$OWNED_CHAIN" -d "$PROXY_RUNTIME_IP" -p tcp --dport 8080 -j ACCEPT -m comment --comment "$(comment_for proxy)"

  # Allow fixed control-plane/models-gateway HTTPS endpoints.
  for addr in "$CONTROL_PLANE_IPV4" "$MODELS_GATEWAY_IPV4"; do
    "$IPTABLES" -A "$OWNED_CHAIN" -d "$addr" -p tcp --dport 443 -j ACCEPT -m comment --comment "$(comment_for control-plane-or-models)"
  done

  # Optional DNS resolver.
  if [ -n "${DNS_RESOLVER_IPV4:-}" ]; then
    "$IPTABLES" -A "$OWNED_CHAIN" -d "$DNS_RESOLVER_IPV4" -p udp --dport 53 -j ACCEPT -m comment --comment "$(comment_for dns-udp)"
    "$IPTABLES" -A "$OWNED_CHAIN" -d "$DNS_RESOLVER_IPV4" -p tcp --dport 53 -j ACCEPT -m comment --comment "$(comment_for dns-tcp)"
    "$IPTABLES" -A "$OWNED_CHAIN" -d "$DNS_RESOLVER_IPV4" -p tcp --dport 853 -j ACCEPT -m comment --comment "$(comment_for dns-tls)"
  fi

  "$IPTABLES" -A "$OWNED_CHAIN" -j DROP -m comment --comment "$(comment_for default-drop)"
  "$IPTABLES" -I "$CHAIN" 1 -s "$RUNTIME_SUBNET" -j "$OWNED_CHAIN" -m comment --comment "$(comment_for jump)"
}

install_ipv6_drop() {
  if ! "$IP6TABLES" -n -L "$CHAIN" >/dev/null 2>&1; then
    echo "IPv6 DOCKER-USER chain absent; skipping IPv6 default drop." >&2
    return 0
  fi

  remove_owned_rules "$IP6TABLES" "$CHAIN"
  delete_owned_chain "$IP6TABLES" "$OWNED_CHAIN_V6"

  if [ -z "${RUNTIME_SUBNET_IPV6:-}" ]; then
    echo "No runtime IPv6 subnet configured; Compose must keep IPv6 disabled." >&2
    return 0
  fi

  reset_owned_chain "$IP6TABLES" "$OWNED_CHAIN_V6"
  "$IP6TABLES" -A "$OWNED_CHAIN_V6" -j DROP -m comment --comment "$(comment_for default-drop-ipv6)"
  "$IP6TABLES" -I "$CHAIN" 1 -s "$RUNTIME_SUBNET_IPV6" -j "$OWNED_CHAIN_V6" -m comment --comment "$(comment_for jump-ipv6)"
}

case "${1:-apply}" in
  apply)
    install_ipv4_rules
    install_ipv6_drop
    echo "Runtime egress rules installed."
    ;;
  remove)
    ensure_chain
    remove_owned_rules "$IPTABLES" "$CHAIN"
    delete_owned_chain "$IPTABLES" "$OWNED_CHAIN"
    if "$IP6TABLES" -n -L "$CHAIN" >/dev/null 2>&1; then
      remove_owned_rules "$IP6TABLES" "$CHAIN"
      delete_owned_chain "$IP6TABLES" "$OWNED_CHAIN_V6"
    fi
    echo "Runtime egress rules removed."
    ;;
  *)
    die "Usage: $0 [apply|remove]"
    ;;
esac
