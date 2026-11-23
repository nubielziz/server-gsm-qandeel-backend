#!/usr/bin/env bash
# The rules of the offsite bucket on Cloudflare R2 (decision 059, docs/OPERATIONS.md section 4): its lifecycle rules (how long copies
# are kept) and its bucket lock rules (how long nobody can delete or overwrite them), set through Cloudflare's API.
#
# Why the lock rules: R2's object key ("Object Read & Write") can also delete, and R2 has no key that may only write. The key on the
# server is therefore able to delete; the lock rules are what keeps a stolen server key from destroying or overwriting past copies.
# Each lock ends a few days before the lifecycle rule of the same prefix removes the object, so the two never meet (a locked object
# is not removed by a lifecycle rule). files-age/ is locked for good: the purge after an erasure request is an act of the owner, who
# switches that one rule off for the time of the purge and on again (the runbook gives the steps).
#
#   lifecycle (removal)                          lock (no delete, no overwrite)
#   db/incoming/  after 2 days                   -
#   db/daily/     after DAILY_DAYS + 5 days      DAILY_DAYS days
#   db/monthly/   after 400 days                 395 days
#   config/       after DAILY_DAYS + 5 days      DAILY_DAYS days
#   files-age/    never                          for good
#   unfinished multipart uploads aborted after 2 days
#
# Usage: CLOUDFLARE_API_TOKEN=... r2-bucket-rules.sh <account id> <bucket> show|apply
#   show   prints both rule sets as the API returns them (JSON)
#   apply  replaces both rule sets with the ones above, then prints what show prints
# DAILY_DAYS (default 30) is the daily retention. R2_JURISDICTION (optional; letters, digits and dashes, for example eu) names the
# jurisdiction of a bucket created in one: every request then carries the header "cf-r2-jurisdiction: <value>", without which the API
# does not find such a bucket. The token needs the R2 edit permission of the account; it is read from the
# environment and reaches curl through a config on its standard input, never through its arguments. Needs curl and python3.
# A response with "success": false prints its errors and exits non-zero.
set -euo pipefail
umask 077

usage() {
  echo "usage: CLOUDFLARE_API_TOKEN=... r2-bucket-rules.sh <account id> <bucket> show|apply" >&2
  exit 2
}

[ $# -eq 3 ] || usage
account=$1 bucket=$2 action=$3
case $action in show | apply) ;; *) usage ;; esac
[[ $account =~ ^[A-Za-z0-9]+$ ]] || usage
[[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || usage
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "r2-bucket-rules.sh: set CLOUDFLARE_API_TOKEN to a Cloudflare API token with the R2 edit permission of the account" >&2
  exit 2
fi
if ! [[ $CLOUDFLARE_API_TOKEN =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
  echo "r2-bucket-rules.sh: CLOUDFLARE_API_TOKEN holds characters a token does not have" >&2
  exit 2
fi
R2_JURISDICTION=${R2_JURISDICTION:-}
if [ -n "$R2_JURISDICTION" ] && ! [[ $R2_JURISDICTION =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "r2-bucket-rules.sh: R2_JURISDICTION holds letters, digits and dashes only (for example eu)" >&2
  exit 2
fi
DAILY_DAYS=${DAILY_DAYS:-30}
if ! [[ $DAILY_DAYS =~ ^[1-9][0-9]*$ ]]; then
  echo "r2-bucket-rules.sh: DAILY_DAYS must be a whole number of days, at least 1" >&2
  exit 2
fi
for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "r2-bucket-rules.sh: $tool is needed" >&2
    exit 2
  }
done

base="https://api.cloudflare.com/client/v4/accounts/$account/r2/buckets/$bucket"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One call of the API; the answer is written to $work/<name>.json. Fails when curl fails or the answer does not say "success": true,
# after printing the errors it names.
api() { # <name> <method> <path> [body file]
  local name=$1 method=$2 path=$3 body=${4:-} args
  args=(-sS -m 60 -X "$method" -H 'Accept: application/json' -o "$work/$name.json")
  [ -z "$R2_JURISDICTION" ] || args+=(-H "cf-r2-jurisdiction: $R2_JURISDICTION")
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | curl "${args[@]}" -K - "$base/$path" || {
    echo "r2-bucket-rules.sh: $method $path: the request failed" >&2
    return 1
  }
  python3 - "$work/$name.json" "$method $path" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        answer = json.load(f)
except Exception:
    print(f"r2-bucket-rules.sh: {sys.argv[2]}: the answer is not JSON", file=sys.stderr)
    sys.exit(1)
if not isinstance(answer, dict) or answer.get("success") is not True:
    errors = answer.get("errors") if isinstance(answer, dict) else None
    print(f"r2-bucket-rules.sh: {sys.argv[2]} failed:", file=sys.stderr)
    for error in errors or [{"message": "no success in the answer"}]:
        print(f"  {error.get('code', '')} {error.get('message', error)}", file=sys.stderr)
    sys.exit(1)
PY
}

show() {
  api lifecycle GET lifecycle || return 1
  api lock GET lock || return 1
  python3 - "$work/lifecycle.json" "$work/lock.json" <<'PY'
import json, sys
result = {}
for key, path in (("lifecycle", sys.argv[1]), ("lock", sys.argv[2])):
    with open(path) as f:
        result[key] = json.load(f).get("result")
print(json.dumps(result, indent=2))
PY
}

if [ "$action" = apply ]; then
  python3 - "$DAILY_DAYS" "$work/lifecycle-body.json" "$work/lock-body.json" <<'PY'
import json, sys
daily = int(sys.argv[1])
day = 86400

def removal(rule_id, prefix, days):
    return {
        "id": rule_id,
        "enabled": True,
        "conditions": {"prefix": prefix},
        "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": days * day}},
    }

def lock(rule_id, prefix, days):
    return {"id": rule_id, "enabled": True, "prefix": prefix, "condition": {"type": "Age", "maxAgeSeconds": days * day}}

lifecycle = {
    "rules": [
        removal("db-incoming", "db/incoming/", 2),
        removal("db-daily", "db/daily/", daily + 5),
        removal("db-monthly", "db/monthly/", 400),
        removal("config", "config/", daily + 5),
        {
            "id": "abort-multipart",
            "enabled": True,
            "conditions": {"prefix": ""},
            "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 2 * day}},
        },
    ]
}
locks = {
    "rules": [
        lock("lock-db-daily", "db/daily/", daily),
        lock("lock-db-monthly", "db/monthly/", 395),
        lock("lock-config", "config/", daily),
        {"id": "lock-files", "enabled": True, "prefix": "files-age/", "condition": {"type": "Indefinite"}},
    ]
}
with open(sys.argv[2], "w") as f:
    json.dump(lifecycle, f)
with open(sys.argv[3], "w") as f:
    json.dump(locks, f)
PY
  api put-lifecycle PUT lifecycle "$work/lifecycle-body.json"
  api put-lock PUT lock "$work/lock-body.json"
  echo "r2-bucket-rules.sh: the lifecycle and lock rules of $bucket are set (daily copies: $DAILY_DAYS days)" >&2
fi
show
