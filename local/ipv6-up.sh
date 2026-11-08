#!/bin/sh
# local/ipv6-up.sh — Enable IPv6 ULA/Global addressing, Neighbor Discovery, and ::/0 default route on eth0 in LinuxOnTab (1.0 & 2.0 WASM).
set -e

IFACE="${1:-eth0}"
GUEST_IP6="${GUEST_IP6:-fd00:86::100/64}"
GW_IP6="${GW_IP6:-fd00:86::1}"
GW_MAC="${GW_MAC:-52:54:00:01:02:03}"

ifconfig "$IFACE" add "$GUEST_IP6" 2>/dev/null || ip -6 addr add "$GUEST_IP6" dev "$IFACE" 2>/dev/null || true
ip -6 neigh replace "$GW_IP6" lladdr "$GW_MAC" nud permanent dev "$IFACE" 2>/dev/null || true
route -A inet6 add ::/0 gw "$GW_IP6" dev "$IFACE" 2>/dev/null || ip -6 route replace default via "$GW_IP6" dev "$IFACE" 2>/dev/null || true

echo "[ipv6] $IFACE configured: addr=$GUEST_IP6 gw=$GW_IP6 (mac=$GW_MAC)"
ifconfig "$IFACE" 2>/dev/null | grep -E "inet6|eth0" || ip -6 addr show dev "$IFACE"
