#!/usr/bin/env bash
# Stub of age for test/tooling/backup-host.test.ts: writes the age version line and the input in base64, so the plaintext is not readable
# in what it gives. STUB_AGE_EXIT makes it fail.
set -u
echo "age $*" >> "$STUB_DIR/calls.log"
if [ "${STUB_AGE_EXIT:-0}" != 0 ]; then
  cat > /dev/null
  exit "$STUB_AGE_EXIT"
fi
printf 'age-encryption.org/v1\n'
base64 -w0
echo
echo "age finished" >> "$STUB_DIR/calls.log"
