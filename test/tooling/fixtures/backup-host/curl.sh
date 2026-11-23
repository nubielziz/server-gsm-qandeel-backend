#!/usr/bin/env bash
# Stub of curl for test/tooling/backup-host.test.ts: keeps the arguments, the config read on standard input and the mail it uploads of
# call n in $STUB_DIR/curl-<n>.{args,config,mail}. STUB_CURL_EXIT makes it fail.
set -u
n=$(($(cat "$STUB_DIR/curl-count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STUB_DIR/curl-count"
echo "curl $n" >> "$STUB_DIR/calls.log"
printf '%s\n' "$@" > "$STUB_DIR/curl-$n.args"
cat > "$STUB_DIR/curl-$n.config"
prev=""
for arg in "$@"; do
  [ "$prev" != --upload-file ] || cp "$arg" "$STUB_DIR/curl-$n.mail"
  prev=$arg
done
if [ "${STUB_CURL_EXIT:-0}" != 0 ]; then
  echo "curl: (67) Login denied" >&2
  exit "$STUB_CURL_EXIT"
fi
