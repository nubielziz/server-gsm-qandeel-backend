#!/bin/sh
# Lets only the CDN reach the web ports of the server (docs/OPERATIONS.md section 1, decision 058).
#
# Docker publishes Caddy's ports with rules of its own, which a host firewall such as ufw does not see, so the limit lives in
# Docker's DOCKER-USER chain: a packet that opens a connection to port 80 or 443 from outside is dropped unless it comes from one
# of the ranges. Answers to connections the containers open themselves are not touched. The origin is reached over IPv4 only,
# so over IPv6 the web ports are closed to everyone: publish no AAAA record for the server.
#
# Safe to run again, and nothing is open in between: the list is replaced in one step, and rules that are there stay. The unit
# gsm-origin-firewall.service runs it before Docker starts (Docker keeps what it finds in DOCKER-USER), so the ports are never
# open without the limit. The rules name the interface of the default route: a server with a second public interface needs its own.
#
# Usage: origin-firewall.sh <ranges file>   (one CIDR per line; IPv6 ranges, empty lines and # comments are skipped)
set -eu
RANGES=${1:?usage: origin-firewall.sh <ranges file>}
[ -r "$RANGES" ] || { echo "origin-firewall.sh: cannot read $RANGES" >&2; exit 2; }
IF=$(ip -4 route show default | awk '{print $5; exit}')
[ -n "$IF" ] || { echo "origin-firewall.sh: no default IPv4 route" >&2; exit 2; }

ipset create gsm-cdn4-next hash:net family inet -exist
ipset flush gsm-cdn4-next
count=0
while IFS= read -r line; do
  case "$line" in '' | '#'* | *:*) continue ;; esac
  ipset add gsm-cdn4-next "$line" -exist
  count=$((count + 1))
done < "$RANGES"
if [ "$count" -eq 0 ]; then
  ipset destroy gsm-cdn4-next
  echo "origin-firewall.sh: $RANGES holds no IPv4 range: nothing changed" >&2
  exit 2
fi
ipset create gsm-cdn4 hash:net family inet -exist
ipset swap gsm-cdn4-next gsm-cdn4
ipset destroy gsm-cdn4-next

# The chain: a packet from the list goes on, any other is dropped. Built once and never emptied.
iptables -N GSM-ORIGIN 2>/dev/null || true
iptables -C GSM-ORIGIN -m set --match-set gsm-cdn4 src -j RETURN 2>/dev/null || iptables -I GSM-ORIGIN 1 -m set --match-set gsm-cdn4 src -j RETURN
iptables -C GSM-ORIGIN -j DROP 2>/dev/null || iptables -A GSM-ORIGIN -j DROP
iptables -N DOCKER-USER 2>/dev/null || true
for spec in "tcp 80" "tcp 443" "udp 443"; do
  # shellcheck disable=SC2086
  set -- $spec
  iptables -C DOCKER-USER -i "$IF" -p "$1" -m conntrack --ctorigdstport "$2" --ctdir ORIGINAL -j GSM-ORIGIN 2>/dev/null ||
    iptables -I DOCKER-USER 1 -i "$IF" -p "$1" -m conntrack --ctorigdstport "$2" --ctdir ORIGINAL -j GSM-ORIGIN
  # Only where the kernel has IPv6 at all: without it there is nothing to close, and the command would fail.
  if [ -e /proc/net/if_inet6 ] && command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C INPUT ! -i lo -p "$1" --dport "$2" -j DROP 2>/dev/null || ip6tables -I INPUT 1 ! -i lo -p "$1" --dport "$2" -j DROP
  fi
done
echo "origin-firewall.sh: ports 80 and 443 on $IF accept $count IPv4 ranges; closed over IPv6"
