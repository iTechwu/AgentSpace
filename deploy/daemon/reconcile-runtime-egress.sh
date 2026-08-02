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

flush_dofe_rules() {
  # Remove every rule in DOCKER-USER that carries our comment prefix.
  while "$IPTABLES" -C "$CHAIN" -m comment --comment "dofe:mcp-egress" 2>/dev/null; do
    local line
    line=$("$IPTABLES" -n -L "$CHAIN" --line-numbers | grep "dofe:mcp-egress" | head -1 | awk '{print $1}')
    [ -n "$line" ] && "$IPTABLES" -D "$CHAIN" "$line" || true
  done
}

install_ipv4_rules() {
  ensure_chain

  # Idempotent cleanup first.
  flush_dofe_rules

  # Allow established/related before any default drop.
  "$IPTABLES" -I "$CHAIN" 1 -s "$RUNTIME_SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT -m comment --comment "$(comment_for established)"

  # Allow proxy.
  "$IPTABLES" -I "$CHAIN" 2 -s "$RUNTIME_SUBNET" -d "$PROXY_RUNTIME_IP" -p tcp --dport 8080 -j ACCEPT -m comment --comment "$(comment_for proxy)"

  # Allow fixed control-plane/models-gateway HTTPS endpoints.
  for addr in "$CONTROL_PLANE_IPV4" "$MODELS_GATEWAY_IPV4"; do
    "$IPTABLES" -I "$CHAIN" 3 -s "$RUNTIME_SUBNET" -d "$addr" -p tcp --dport 443 -j ACCEPT -m comment --comment "$(comment_for control-plane-or-models)"
  done

  # Optional DNS resolver.
  if [ -n "${DNS_RESOLVER_IPV4:-}" ]; then
    "$IPTABLES" -I "$CHAIN" 4 -s "$RUNTIME_SUBNET" -d "$DNS_RESOLVER_IPV4" -p udp --dport 53 -j ACCEPT -m comment --comment "$(comment_for dns-udp)"
    "$IPTABLES" -I "$CHAIN" 5 -s "$RUNTIME_SUBNET" -d "$DNS_RESOLVER_IPV4" -p tcp --dport 53 -j ACCEPT -m comment --comment "$(comment_for dns-tcp)"
  fi

  # Default drop everything else from the runtime subnet.
  "$IPTABLES" -A "$CHAIN" -s "$RUNTIME_SUBNET" -j DROP -m comment --comment "$(comment_for default-drop)"
}

install_ipv6_drop() {
  if ! "$IP6TABLES" -n -L "$CHAIN" >/dev/null 2>&1; then
    echo "IPv6 DOCKER-USER chain absent; skipping IPv6 default drop." >&2
    return 0
  fi

  # Remove prior dofe IPv6 rules.
  while "$IP6TABLES" -C "$CHAIN" -m comment --comment "dofe:mcp-egress" 2>/dev/null; do
    local line
    line=$("$IP6TABLES" -n -L "$CHAIN" --line-numbers | grep "dofe:mcp-egress" | head -1 | awk '{print $1}')
    [ -n "$line" ] && "$IP6TABLES" -D "$CHAIN" "$line" || true
  done

  "$IP6TABLES" -A "$CHAIN" -s "$RUNTIME_SUBNET" -j DROP -m comment --comment "$(comment_for default-drop-ipv6)"
}

case "${1:-apply}" in
  apply)
    install_ipv4_rules
    install_ipv6_drop
    echo "Runtime egress rules installed."
    ;;
  remove)
    ensure_chain
    flush_dofe_rules
    if "$IP6TABLES" -n -L "$CHAIN" >/dev/null 2>&1; then
      while "$IP6TABLES" -C "$CHAIN" -m comment --comment "dofe:mcp-egress" 2>/dev/null; do
        local line
        line=$("$IP6TABLES" -n -L "$CHAIN" --line-numbers | grep "dofe:mcp-egress" | head -1 | awk '{print $1}')
        [ -n "$line" ] && "$IP6TABLES" -D "$CHAIN" "$line" || true
      done
    fi
    echo "Runtime egress rules removed."
    ;;
  *)
    die "Usage: $0 [apply|remove]"
    ;;
esac
