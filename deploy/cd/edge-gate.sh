#!/usr/bin/env bash
# The closed edge of the production server (docs/OPERATIONS.md, "The closed edge"; the snippet edge_gate of deploy/Caddyfile).
#
#   gsm-edge-gate close <address>   every public host answers 503 to any client address but this one, the operator's
#   gsm-edge-gate open              every address reaches the hosts again
#   gsm-edge-gate status            says which of the two it is, and what Caddy runs
#
# Why: a release that changes the database is tried on the real hosts by the operator alone before anybody else can reach them, and
# the last moment a restore is a rollback is the moment the edge opens again.
#
# How: the gate is one small file, <ROOT>/edge/closed.caddy, which every host of the Caddyfile reads when Caddy loads it. "close" writes
# the file, asks the running Caddy to check its Caddyfile with the file in place, tells Caddy to load it, and then reads Caddy's running
# configuration to see that every public host holds the gate. "open" removes the file and does the same the other way round. A check
# or a load that fails puts the file back as it was, so the folder always says what Caddy runs. With a CDN in front, the client
# address is the one the CDN's header names (deploy/cd/edge-cdn.py), so the address to give is the operator's own, not the CDN's.
#
# Settings: /etc/gsm-deploy.conf, the file of gsm-auto-deploy (ROOT, and COMPOSE_OVERRIDE when the server has one). EDGE_DIR names the
# folder when it is not <ROOT>/edge (deploy/compose.prod.yaml mounts <ROOT>/edge). Needs docker and python3. Run it as root.
#
# Exit status: 0 done, 1 refused or failed (the folder is as it was), 2 wrong use or settings.
set -euo pipefail

CONF=${GSM_DEPLOY_CONF:-/etc/gsm-deploy.conf}
if [ ! -r "$CONF" ]; then
  echo "edge-gate: cannot read $CONF (template: deploy/cd/auto-deploy.conf.example)" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$CONF"
if [ -z "${ROOT:-}" ]; then
  echo "edge-gate: set ROOT in $CONF" >&2
  exit 2
fi
COMPOSE_OVERRIDE=${COMPOSE_OVERRIDE:-}
EDGE_DIR=${EDGE_DIR:-$ROOT/edge}
GATE_FILE=$EDGE_DIR/closed.caddy
# Where the container sees the folder and its Caddyfile (deploy/compose.prod.yaml and the server's own Caddyfile mount both).
SEEN_DIR=/etc/caddy/edge
CADDYFILE=/etc/caddy/Caddyfile
# The text only the closed answer holds: counting it in Caddy's running configuration counts the hosts that run the gate.
MARK=EDGE_CLOSED

say() { printf '%s\n' "$*"; }

fail() {
  printf 'edge-gate: %s\n' "$*" >&2
  exit 1
}

usage() {
  echo "usage: gsm-edge-gate close <address> | open | status" >&2
  exit 2
}

compose() {
  local files=(-f deploy/compose.prod.yaml)
  if [ -n "$COMPOSE_OVERRIDE" ]; then files+=(-f "$COMPOSE_OVERRIDE"); fi
  (cd "$ROOT/backend" && docker compose "${files[@]}" --env-file deploy/.env "$@")
}

in_caddy() { compose exec -T caddy "$@"; }

# The address in its written form, or a message and status 1. One address: not a range, not a name, and not one a visitor cannot have
# (the matcher of the gate would never or always match it).
canonical_address() { # <address>
  python3 -c '
import ipaddress, sys
text = sys.argv[1]
try:
    address = ipaddress.ip_address(text)
except ValueError:
    sys.exit("not an IPv4 or IPv6 address (one address, no range, no name): " + repr(text))
if "%" in text or address.is_unspecified or address.is_multicast or getattr(address, "ipv4_mapped", None) is not None:
    sys.exit("not an address a visitor can have (zone, unspecified, multicast or IPv4-mapped): " + repr(text))
print(address)
' "$1"
}

# Caddy reads every file of the folder whose name starts with "closed.caddy" (a glob is the only way to import a file that may be
# absent): the one name of the gate is the only one allowed.
check_folder() {
  local entry
  for entry in "$EDGE_DIR"/closed.caddy*; do
    [ -e "$entry" ] || continue
    [ "$entry" = "$GATE_FILE" ] || fail "$entry would be read by Caddy as well: remove it first"
  done
}

# The number of site blocks of the Caddyfile that Caddy's container runs, and how many of them import the gate: they must be equal.
hosts_of_caddy() {
  local hosts gated
  in_caddy test -d "$SEEN_DIR" || fail "Caddy's container does not run, or does not mount the folder $SEEN_DIR: deploy the backend first, then: gsmc up -d caddy"
  hosts=$(in_caddy grep -c -E '^\{\$[A-Z_]+\} \{$' "$CADDYFILE" || true)
  gated=$(in_caddy grep -c -E '^[[:space:]]*import edge_gate$' "$CADDYFILE" || true)
  if [ -z "$hosts" ] || [ "$hosts" = 0 ] || [ "$hosts" != "$gated" ]; then
    fail "the Caddyfile that Caddy runs does not import the gate on every host (${gated:-0} of ${hosts:-0}): deploy the backend first"
  fi
  printf '%s\n' "$hosts"
}

# How many hosts Caddy runs the closed answer on, read from its running configuration; "unreadable" when it cannot be read.
running_gates() {
  local count
  if count=$(in_caddy sh -c "wget -qO- http://127.0.0.1:2019/config/ | grep -o $MARK | wc -l" 2>/dev/null) && [ -n "$count" ]; then
    printf '%s\n' "$((count + 0))"
  else
    echo unreadable
  fi
}

# The file as it was before a change, so that a refused change leaves the folder as Caddy runs it.
PREVIOUS=""
save_gate() {
  PREVIOUS=""
  if [ -f "$GATE_FILE" ]; then
    PREVIOUS=$(mktemp) || fail "cannot make a temporary file"
    cp -p "$GATE_FILE" "$PREVIOUS" || fail "cannot save $GATE_FILE"
  fi
}

restore_gate() {
  if [ -n "$PREVIOUS" ]; then
    if ! { cp -p "$PREVIOUS" "$EDGE_DIR/.closed.caddy.new" && mv -f "$EDGE_DIR/.closed.caddy.new" "$GATE_FILE"; }; then
      echo "edge-gate: THE FILE $GATE_FILE COULD NOT BE PUT BACK: look at it now" >&2
    fi
    rm -f "$PREVIOUS"
  else
    rm -f "$GATE_FILE"
  fi
  PREVIOUS=""
}

# The file of the closed edge: one operator address, and the answer every other address gets, in the form of RFC 9457 (the API's own
# error body has the same members).
write_gate() { # <address as written by canonical_address>
  local temporary=$EDGE_DIR/.closed.caddy.new
  mkdir -p "$EDGE_DIR" || return 1
  {
    printf '# Written by gsm-edge-gate (deploy/cd/edge-gate.sh) on %s. Do not edit; "gsm-edge-gate open" removes this file.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '@edge_closed not client_ip %s\n' "$1"
    cat <<'EOF'
handle @edge_closed {
	header Content-Type "application/problem+json; charset=utf-8"
	header Cache-Control "no-store"
	respond `{"type":"about:blank","title":"The service is closed.","status":503,"code":"EDGE_CLOSED","detail":"The service is closed for a short time. Try again later.","requestId":"{http.request.uuid}"}` 503
}
EOF
  } >"$temporary" || return 1
  chmod 0644 "$temporary" || return 1
  mv -f "$temporary" "$GATE_FILE"
}

# With the folder changed: the container sees the change, Caddy accepts its Caddyfile, Caddy loads it, and its running configuration
# holds the gate on <expected> hosts (0 when open). Any failure puts the file back and stops with status 1: Caddy keeps what it ran.
apply_change() { # <expected hosts: the count, or 0>
  local want=$1 seen out running
  if [ "$want" = 0 ]; then
    if in_caddy test -e "$SEEN_DIR/closed.caddy"; then seen=bad; else seen=ok; fi
  else
    if in_caddy test -f "$SEEN_DIR/closed.caddy"; then seen=ok; else seen=bad; fi
  fi
  if [ "$seen" != ok ]; then
    restore_gate
    fail "Caddy's container does not see the change of the folder: nothing was loaded and the folder is as it was"
  fi
  if ! out=$(in_caddy caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1); then
    printf '%s\n' "$out" >&2
    restore_gate
    fail "Caddy refused its Caddyfile with the change: nothing was loaded and the folder is as it was"
  fi
  if ! out=$(in_caddy caddy reload --config "$CADDYFILE" --adapter caddyfile 2>&1); then
    printf '%s\n' "$out" >&2
    restore_gate
    fail "Caddy did not load its Caddyfile: it keeps what it ran, and the folder is as it was"
  fi
  if [ -n "$PREVIOUS" ]; then rm -f "$PREVIOUS"; fi
  PREVIOUS=""
  running=$(running_gates)
  if [ "$running" = unreadable ]; then
    fail "Caddy loaded its Caddyfile, but its running configuration cannot be read: look at it now (gsm-edge-gate status)"
  fi
  if [ "$running" != "$want" ]; then
    fail "Caddy loaded its Caddyfile, but the gate runs on $running hosts, not $want: look at it now (gsm-edge-gate status), and open again if you doubt it"
  fi
}

close_edge() { # <address>
  local address hosts
  [ $# -eq 1 ] || usage
  address=$(canonical_address "$1") || {
    echo "edge-gate: refused the address" >&2
    exit 2
  }
  check_folder
  hosts=$(hosts_of_caddy)
  save_gate
  if ! write_gate "$address"; then
    restore_gate
    fail "cannot write $GATE_FILE"
  fi
  apply_change "$hosts"
  say "closed: all $hosts public hosts answer 503 to every address but $address. Open again with: gsm-edge-gate open"
}

open_edge() {
  [ $# -eq 0 ] || usage
  check_folder
  hosts_of_caddy >/dev/null
  save_gate
  rm -f "$GATE_FILE" || fail "cannot remove $GATE_FILE"
  # Caddy is told even when the file was not there: a file removed by hand leaves Caddy running the closed form.
  apply_change 0
  say "open: every address reaches the public hosts"
}

status() {
  local operator running
  [ $# -eq 0 ] || usage
  check_folder
  if [ -f "$GATE_FILE" ]; then
    operator=$(sed -n 's/^@edge_closed not client_ip \(.*\)$/\1/p' "$GATE_FILE")
    if [ -z "$operator" ] || ! canonical_address "$operator" >/dev/null 2>&1; then
      fail "$GATE_FILE does not name one address: run gsm-edge-gate close <address>, or open"
    fi
    say "the folder: closed to every address but $operator"
  else
    say "the folder: open"
  fi
  running=$(running_gates)
  case "$running" in
    unreadable) say "Caddy: its running configuration cannot be read (is the container up?)" ;;
    0) say "Caddy runs: open" ;;
    *) say "Caddy runs: closed on $running hosts" ;;
  esac
}

case "${1:-}" in
  close)
    shift
    close_edge "$@"
    ;;
  open)
    shift
    open_edge "$@"
    ;;
  status)
    shift
    status "$@"
    ;;
  *) usage ;;
esac
