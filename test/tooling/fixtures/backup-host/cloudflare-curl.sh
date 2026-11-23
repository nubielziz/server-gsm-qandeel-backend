#!/usr/bin/env bash
# Stub of curl for the r2-bucket-rules.sh tests of test/tooling/backup-host.test.ts: keeps the arguments, the config read on standard
# input and the body of call n in $STUB_DIR/curl-<n>.{args,config,body}, and answers like Cloudflare's API into the -o file.
# STUB_FAIL_ON="<METHOD> <last path segment>" (for example "PUT lock") answers that call with "success": false.
set -u
n=$(($(cat "$STUB_DIR/curl-count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STUB_DIR/curl-count"
printf '%s\n' "$@" > "$STUB_DIR/curl-$n.args"
cat > "$STUB_DIR/curl-$n.config"
out=/dev/null method=GET prev=""
for arg in "$@"; do
  case $prev in
    -o) out=$arg ;;
    -X) method=$arg ;;
    --data-binary) cp "${arg#@}" "$STUB_DIR/curl-$n.body" ;;
  esac
  prev=$arg
done
url=${*: -1}
if [ "$method ${url##*/}" = "${STUB_FAIL_ON:-}" ]; then
  printf '{"success":false,"errors":[{"code":10006,"message":"The specified bucket does not exist."}],"messages":[],"result":null}' > "$out"
else
  printf '{"success":true,"errors":[],"messages":[],"result":{"rules":[{"id":"%s-%s"}]}}' "$method" "${url##*/}" > "$out"
fi
