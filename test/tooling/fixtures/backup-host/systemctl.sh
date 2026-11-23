#!/usr/bin/env bash
# Stub of systemctl for test/tooling/backup-host.test.ts: the next times of the two timers.
set -u
echo "systemctl $*" >> "$STUB_DIR/calls.log"
case "$*" in
  "show gsm-backup.timer "*) echo "Wed 2026-11-11 01:21:33 UTC" ;;
  "show gsm-backup-check.timer "*) echo "Wed 2026-11-11 07:30:00 UTC" ;;
esac
