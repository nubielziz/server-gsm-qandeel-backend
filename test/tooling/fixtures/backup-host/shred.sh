#!/usr/bin/env bash
# Stub of shred for test/tooling/backup-host.test.ts: removes the file like shred -u. STUB_SHRED_EXIT makes it fail without removing it.
set -u
echo "shred $*" >> "$STUB_DIR/calls.log"
[ "${STUB_SHRED_EXIT:-0}" = 0 ] || exit "$STUB_SHRED_EXIT"
rm -f "${@: -1}"
