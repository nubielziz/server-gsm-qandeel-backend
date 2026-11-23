#!/usr/bin/env bash
# Stub of docker for test/tooling/backup-host.test.ts: records its call in $STUB_DIR/calls.log and plays the backup container's scripts.
# STUB_BUILD_EXIT, STUB_IMAGE_EXISTS, STUB_DB_EXIT, STUB_FILES_EXIT, STUB_CONFIG_EXIT, STUB_STATUS_EXIT, STUB_DRILL_EXIT and
# STUB_DRILL_SLEEP change what it does; STUB_DB_SLEEP, STUB_CONFIG_SLEEP and STUB_DRILL_SLEEP make that step wait (its process id in
# $STUB_DIR/docker.pid); $STUB_DIR/status holds what offsite-status.sh prints.
set -u
echo "docker $*" >> "$STUB_DIR/calls.log"
case "$*" in
  *" build backup") exit "${STUB_BUILD_EXIT:-0}" ;;
  "image inspect "*) [ "${STUB_IMAGE_EXISTS:-1}" = 1 ] ;;
  *" pg-backup.sh")
    if [ -n "${STUB_DB_SLEEP:-}" ]; then
      echo $$ > "$STUB_DIR/docker.pid"
      exec sleep "$STUB_DB_SLEEP"
    fi
    if [ "${STUB_DB_EXIT:-0}" != 0 ]; then
      echo "pg_dump: error: connection to the server failed" >&2
      exit "$STUB_DB_EXIT"
    fi
    echo '{"ts":"2026-11-10T01:16:00Z","script":"pg-backup","step":"done","msg":"backup gsm-20261110T011500Z.dump.age complete"}'
    ;;
  *" files-mirror.sh") exit "${STUB_FILES_EXIT:-0}" ;;
  *" config-copy.sh "*)
    cat > "$STUB_DIR/config-received"
    if [ -n "${STUB_CONFIG_SLEEP:-}" ]; then
      echo $$ > "$STUB_DIR/docker.pid"
      exec sleep "$STUB_CONFIG_SLEEP"
    fi
    exit "${STUB_CONFIG_EXIT:-0}"
    ;;
  *" offsite-status.sh")
    [ ! -f "$STUB_DIR/status" ] || cat "$STUB_DIR/status"
    if [ "${STUB_STATUS_EXIT:-0}" != 0 ]; then
      echo "ERROR : listing failed (stub)" >&2
      exit "$STUB_STATUS_EXIT"
    fi
    ;;
  *" restore-drill.sh --identity /age.key")
    prev="" key=""
    for arg in "$@"; do
      [ "$prev" != -v ] || key=${arg%%:*}
      prev=$arg
    done
    stat -c %a "$key" > "$STUB_DIR/key-mode"
    cat "$key" > "$STUB_DIR/key-seen"
    if [ -n "${STUB_DRILL_SLEEP:-}" ]; then
      echo $$ > "$STUB_DIR/docker.pid"
      exec sleep "$STUB_DRILL_SLEEP"
    fi
    if [ "${STUB_DRILL_EXIT:-0}" != 0 ]; then
      echo '{"script":"restore-drill","step":"error","msg":"the ledger entries of the restored dump do not sum to zero"}'
      exit "$STUB_DRILL_EXIT"
    fi
    echo '{"script":"restore-drill","step":"check","msg":"ledger_entries sum to zero"}'
    echo '{"ts":"2026-11-10T09:05:00Z","script":"restore-drill","step":"done","msg":"restore drill passed with gsm-20261109T011500Z.dump.age"}'
    ;;
esac
