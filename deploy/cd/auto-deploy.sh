#!/usr/bin/env bash
# Automatic deploys on the production server (decision 057, docs/OPERATIONS.md section 8).
#
# A systemd timer runs "auto-deploy.sh run" every few minutes. For each of the three checkouts (backend, console, shop) it
# fetches the deploy branch and deploys its newest commit when all of this holds:
#   - every workflow run of that commit on GitHub has finished, and all of them succeeded;
#   - the commit continues the history of the commit that runs now (a rewritten branch is never deployed by itself);
#   - the checkout has no local change, and no hold is set.
# Nothing reaches the server from outside: it asks GitHub, GitHub never calls it, and no key of the server is stored there.
# A commit that changes nothing that runs (documents, tests, the workflows) is recorded without a build. A deploy that fails
# puts the previous image back and waits for a newer commit, or for "retry".
#
# Commands:
#   run                              what the timer calls
#   status                           what runs, what is newest, what GitHub says about it
#   hold [reason] | resume           stop and start the automatic deploys
#   retry <backend|console|shop>     try the newest commit again after a failed deploy
#   force <backend|console|shop>     deploy the newest fetched commit without asking GitHub for its checks (its API does
#                                    not answer, or the hour's questions are used up)
# A commit whose message stops the workflows ("[skip ci]") has no run, so it waits until a later commit has one.
# Settings: /etc/gsm-deploy.conf (template: deploy/cd/auto-deploy.conf.example). Needs git, docker, curl and python3.
#
# Inside the functions every step is checked by hand ("|| return 1"): bash does not stop a function at a failing command when
# the function is called in a condition, and every deploy is.
set -euo pipefail

CONF=${GSM_DEPLOY_CONF:-/etc/gsm-deploy.conf}
if [ ! -r "$CONF" ]; then
  echo "auto-deploy: cannot read $CONF (template: deploy/cd/auto-deploy.conf.example)" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$CONF"
: "${ROOT:?set ROOT in the settings file}" "${GITHUB_OWNER:?set GITHUB_OWNER}"
: "${REPO_BACKEND:?set REPO_BACKEND}" "${REPO_CONSOLE:?set REPO_CONSOLE}" "${REPO_SHOP:?set REPO_SHOP}"
BRANCH=${BRANCH:-main}
STATE=${STATE:-/var/lib/gsm-deploy}
DUMPS=${DUMPS:-/var/backups/gsm}
HEALTH_WAIT=${HEALTH_WAIT:-240}
CDN_HEADER=${CDN_HEADER:-}
COMPOSE_OVERRIDE=${COMPOSE_OVERRIDE:-}
PARTS="backend console shop"
# Seconds before GitHub is asked again about a commit whose answer was this (60 unsigned requests an hour are allowed).
ASK_AGAIN_PENDING=300 ASK_AGAIN_NONE=600 ASK_AGAIN_FAILURE=1800 ASK_AGAIN_UNKNOWN=600

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

dir_of() {
  case "$1" in
    backend) echo "$ROOT/backend" ;;
    console) echo "$ROOT/frontend-admin" ;;
    shop) echo "$ROOT/storefront" ;;
    *) return 1 ;;
  esac
}

repo_of() {
  case "$1" in
    backend) echo "$REPO_BACKEND" ;;
    console) echo "$REPO_CONSOLE" ;;
    shop) echo "$REPO_SHOP" ;;
    *) return 1 ;;
  esac
}

compose() {
  local files=(-f deploy/compose.prod.yaml)
  [ -n "$COMPOSE_OVERRIDE" ] && files+=(-f "$COMPOSE_OVERRIDE")
  (cd "$ROOT/backend" && docker compose "${files[@]}" --env-file deploy/.env "$@")
}

# The value of a variable of deploy/.env without a trailing comment; empty when it is not set.
env_of() {
  local line
  line=$(grep -m1 "^$1=" "$ROOT/backend/deploy/.env" 2>/dev/null || true)
  line=${line#*=}
  printf '%s\n' "$line" | sed -E 's/[[:space:]]+#.*$//'
}

# The commit that runs now: the recorded one, or the checkout's own commit before the first deploy.
deployed_of() {
  if [ -s "$STATE/$1.deployed" ]; then
    cat "$STATE/$1.deployed"
  else
    git -C "$(dir_of "$1")" rev-parse HEAD
  fi
}

# What GitHub says about the workflow runs of a commit on the deploy branch: success, pending, failure, none or unknown.
# "none" also when the repository's own workflow (.github/workflows/ci.yml) is not among the runs: another workflow's success,
# or a commit that removed the checks, says nothing.
ci_state() { # <repository> <commit>
  local body
  if ! body=$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$GITHUB_OWNER/$1/actions/runs?head_sha=$2&per_page=50" 2>/dev/null); then
    echo unknown
    return 0
  fi
  python3 -c '
import json, sys
runs = [r for r in json.load(sys.stdin)["workflow_runs"] if r.get("head_branch") == sys.argv[1] and r.get("event") == "push"]
if not any(r.get("path") == ".github/workflows/ci.yml" for r in runs):
    print("none")
elif any(r.get("status") != "completed" for r in runs):
    print("pending")
elif all(r.get("conclusion") == "success" for r in runs):
    print("success")
else:
    print("failure")
' "$BRANCH" <<<"$body" 2>/dev/null || echo unknown
}

# The same answer, asked at most once per waiting time for the same commit; "success" is never remembered.
ci_state_spaced() { # <part> <repository> <commit>
  local memo=$STATE/$1.asked known_sha="" known_state="" known_at=0 wait now state
  now=$(date +%s)
  [ -s "$memo" ] && read -r known_sha known_state known_at <"$memo"
  if [ "$known_sha" = "$3" ]; then
    case "$known_state" in
      pending) wait=$ASK_AGAIN_PENDING ;;
      none) wait=$ASK_AGAIN_NONE ;;
      failure) wait=$ASK_AGAIN_FAILURE ;;
      *) wait=$ASK_AGAIN_UNKNOWN ;;
    esac
    if [ $((now - known_at)) -lt "$wait" ]; then
      echo "$known_state"
      return 0
    fi
  fi
  state=$(ci_state "$2" "$3")
  if [ "$state" = success ]; then rm -f "$memo"; else echo "$3 $state $now" >"$memo"; fi
  echo "$state"
}

# Does the change between two commits need a new image? Documents, tests and the workflows do not.
relevant() { # <part> <from> <to>
  local changed
  changed=$(git -C "$(dir_of "$1")" diff --name-only "$2" "$3") || return 0
  [ -n "$changed" ] || return 1
  # One grep that reads its whole input: with pipefail, a second command that stops reading early would fail the first one.
  case "$1" in
    backend)
      grep -q -E '^(src/|drizzle/|scripts/|deploy/|package\.json$|bun\.lock$|bunfig\.toml$|tsconfig[^/]*\.json$|Dockerfile$|\.dockerignore$)' <<<"$changed"
      ;;
    *)
      grep -q -v -E '(^\.github/|^docs/|^e2e/|^screenshots/|^\.claude/|^\.serena/|\.md$|\.test\.(ts|tsx|mjs)$)' <<<"$changed"
      ;;
  esac
}

# Every named service is healthy (or runs, when it has no health check) within HEALTH_WAIT seconds.
wait_healthy() { # <service>...
  local deadline=$(($(date +%s) + HEALTH_WAIT)) service id state ok
  while :; do
    ok=1
    for service in "$@"; do
      id=$(compose ps -q "$service" 2>/dev/null | head -n1 || true)
      state=""
      [ -n "$id" ] && state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      case "$state" in healthy | running) ;; *) ok=0 ;; esac
    done
    [ "$ok" = 1 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 4
  done
}

# The image the service runs now keeps a second tag, ":previous", so a failed deploy can put it back. It is the running
# container's image, not whatever the tag names: a build that was cut short may have moved the tag to an image nobody checked.
keep_previous() { # <image> <service>
  local id running=""
  id=$(compose ps -q "$2" 2>/dev/null | head -n1 || true)
  [ -n "$id" ] && running=$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null || true)
  if [ -n "$running" ]; then
    docker tag "$running" "${1%:*}:previous"
  elif docker image inspect "$1" >/dev/null 2>&1; then
    docker tag "$1" "${1%:*}:previous"
  fi
}

# The backend's version line of deploy/.env names the commit of the image.
set_version() { # <commit>
  sed -i -E "s/^GIT_SHA=.*/GIT_SHA=${1:0:7}/" "$ROOT/backend/deploy/.env"
}

restore_tag() { # <image>
  if docker image inspect "${1%:*}:previous" >/dev/null 2>&1; then docker tag "${1%:*}:previous" "$1"; fi
}

# After a failed replacement: the checkout, the version line and the image go back first, so the old image starts again with the
# compose file and the settings it was deployed with, and then the containers.
put_back() { # <part> <image> <commit that ran> <service>...
  local part=$1 image=$2 from=$3
  shift 3
  git -C "$(dir_of "$part")" checkout -q --detach "$from" || say "the checkout did not go back to ${from:0:7}"
  if [ "$part" = backend ]; then set_version "$from" || true; fi
  restore_tag "$image"
  compose up -d "$@" || say "compose could not start the containers of ${from:0:7}"
  if wait_healthy "$@"; then
    say "the previous image runs again"
  else
    say "THE PREVIOUS IMAGE DID NOT COME BACK HEALTHY: look at the server now"
  fi
}

# A dump on this disk before a migration; the offsite backup of docs/OPERATIONS.md section 4 runs too when it is set up.
dump_database() { # <commit>
  local file
  file="$DUMPS/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-${1:0:7}.dump"
  mkdir -p "$DUMPS" || return 1
  chmod 700 "$DUMPS" || return 1
  (umask 077 && compose exec -T postgres pg_dump -U gsm -d gsm -Fc >"$file") || return 1
  if [ ! -s "$file" ]; then
    say "the dump is empty: not migrating"
    return 1
  fi
  say "dump before the migration: $file ($(du -h "$file" | cut -f1))"
  # The ten newest dumps stay.
  find "$DUMPS" -maxdepth 1 -name 'pre-deploy-*.dump' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm -f || true
  if [ -n "$(env_of BACKUP_S3_BUCKET)" ]; then
    say "offsite backup before the migration"
    compose run --rm -T backup pg-backup.sh || return 1
  fi
}

# With a CDN in front, the server has a Caddyfile of its own, written from the repository's by deploy/cd/edge-cdn.py.
# edge_prepare writes and checks the new copy beside the old one, before anything is migrated; edge_apply puts it in place
# (in place, because the container mounts the file itself) and tells Caddy, after the containers are replaced.
EDGE_NEW=""
edge_prepare() {
  EDGE_NEW=""
  [ -n "$CDN_HEADER" ] || return 0
  local new image
  new=$(mktemp) || return 1
  if ! python3 "$ROOT/backend/deploy/cd/edge-cdn.py" --ranges "$CDN_RANGES" --header "$CDN_HEADER" \
    --input "$ROOT/backend/deploy/Caddyfile" >"$new"; then
    rm -f "$new"
    return 1
  fi
  image=$(compose config --images 2>/dev/null | grep -m1 -E '^caddy:' || true)
  if ! docker run --rm -e SHOP_HOST="$(env_of SHOP_HOST)" -e ADMIN_HOST="$(env_of ADMIN_HOST)" -e API_HOST="$(env_of API_HOST)" \
    -e FILES_HOST="$(env_of FILES_HOST)" -e ACME_EMAIL="$(env_of ACME_EMAIL)" -e GEOIP_COUNTRY_HEADER="$(env_of GEOIP_COUNTRY_HEADER)" \
    -v "$new:/etc/caddy/Caddyfile:ro" "${image:-caddy:2}" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    rm -f "$new"
    say "the Caddyfile written for the CDN is not valid: nothing changed"
    return 1
  fi
  if [ -f "$EDGE_CADDYFILE" ] && cmp -s "$new" "$EDGE_CADDYFILE"; then
    rm -f "$new"
  else
    EDGE_NEW=$new
  fi
}

edge_discard() {
  [ -n "$EDGE_NEW" ] && rm -f "$EDGE_NEW"
  EDGE_NEW=""
}

edge_apply() {
  [ -n "$EDGE_NEW" ] || return 0
  if ! mkdir -p "$(dirname "$EDGE_CADDYFILE")" || ! cat "$EDGE_NEW" >"$EDGE_CADDYFILE"; then
    edge_discard
    return 1
  fi
  edge_discard
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || say "Caddy did not take its new Caddyfile: gsmc restart caddy"
}

# The deployer and the firewall script follow the repository, and the firewall reads its list again.
install_self() {
  local source=$ROOT/backend/deploy/cd
  [ -f "$source/auto-deploy.sh" ] || return 0
  cmp -s "$source/auto-deploy.sh" /usr/local/sbin/gsm-auto-deploy || install -m 0750 "$source/auto-deploy.sh" /usr/local/sbin/gsm-auto-deploy || true
  if [ -e /usr/local/sbin/gsm-origin-firewall ]; then
    cmp -s "$source/origin-firewall.sh" /usr/local/sbin/gsm-origin-firewall || install -m 0750 "$source/origin-firewall.sh" /usr/local/sbin/gsm-origin-firewall || true
    if systemctl is-enabled --quiet gsm-origin-firewall.service 2>/dev/null; then
      systemctl restart gsm-origin-firewall.service || say "the origin firewall did not restart: systemctl status gsm-origin-firewall"
    fi
  fi
  return 0
}

deploy_backend() { # <from> <to>
  local from=$1 to=$2 dir=$ROOT/backend image added caddyfile
  image=$(env_of BACKEND_IMAGE)
  image=${image:-gsm-backend:local}
  git -C "$dir" checkout -q --detach "$to" || return 1
  set_version "$to" || return 1
  sed -i -E "s/^APP_VERSION=.*/APP_VERSION=$(date -u +%Y.%m.%d)/" "$dir/deploy/.env" || return 1
  keep_previous "$image" api || return 1
  say "building $image"
  compose build api || return 1
  edge_prepare || {
    restore_tag "$image"
    return 1
  }
  added=$(git -C "$dir" diff --name-only --diff-filter=A "$from" "$to" -- drizzle) || added=""
  if grep -q '\.sql$' <<<"$added"; then
    dump_database "$to" || {
      restore_tag "$image"
      edge_discard
      return 1
    }
  fi
  say "migrations"
  compose run --rm migrate || {
    say "the migration step failed: the containers of the commit before keep running"
    restore_tag "$image"
    edge_discard
    return 1
  }
  say "replacing the containers"
  compose up -d || {
    edge_discard
    put_back backend "$image" "$from" api worker
    return 1
  }
  if [ -n "$CDN_HEADER" ]; then
    edge_apply || say "the server's Caddyfile was not replaced"
  else
    # With no CDN the container mounts the repository's own file, and a checkout replaces that file: Caddy must start again to see it.
    caddyfile=$(git -C "$dir" diff --name-only "$from" "$to" -- deploy/Caddyfile) || caddyfile=""
    if [ -n "$caddyfile" ]; then compose up -d --force-recreate caddy || say "Caddy did not start again: gsmc up -d --force-recreate caddy"; fi
  fi
  if ! wait_healthy api worker; then
    say "the new containers are not healthy within $HEALTH_WAIT s"
    compose logs --tail 40 api worker || true
    # Caddy is named too: when it was started again a moment ago and did not come up, this starts it.
    put_back backend "$image" "$from" api worker caddy
    return 1
  fi
  install_self
}

deploy_console() { # <from> <to>
  local from=$1 to=$2 dir=$ROOT/frontend-admin image id page
  image=$(env_of CONSOLE_IMAGE)
  image=${image:-gsm-console:local}
  git -C "$dir" checkout -q --detach "$to" || return 1
  keep_previous "$image" console || return 1
  say "building $image"
  docker build -t "$image" --build-arg VITE_API_BASE_URL="" "$dir" || return 1
  compose up -d console || {
    put_back console "$image" "$from" console
    return 1
  }
  wait_healthy console || {
    put_back console "$image" "$from" console
    return 1
  }
  id=$(compose ps -q console | head -n1 || true)
  page=$(docker exec "$id" wget -qO- http://127.0.0.1/ 2>/dev/null || true)
  if ! grep -q '<title>' <<<"$page"; then
    say "the console's page does not answer"
    put_back console "$image" "$from" console
    return 1
  fi
}

deploy_shop() { # <from> <to>
  local from=$1 to=$2 dir=$ROOT/storefront image
  image=$(env_of SITE_IMAGE)
  image=${image:-gsm-site:local}
  if [ -z "${SHOP_SITE_URL:-}" ] || [ -z "${SHOP_BUILD_API_ORIGIN:-}" ] || [ -z "${SHOP_TURNSTILE_SITE_KEY:-}" ]; then
    say "the shop's build values are not set in $CONF"
    return 1
  fi
  git -C "$dir" checkout -q --detach "$to" || return 1
  keep_previous "$image" site || return 1
  say "building $image"
  docker build -t "$image" \
    --build-arg GSM_API_ORIGIN="$SHOP_BUILD_API_ORIGIN" \
    --build-arg GSM_API_REWRITE_ORIGIN=http://api:3000 \
    --build-arg NEXT_PUBLIC_SITE_URL="$SHOP_SITE_URL" \
    --build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY="$SHOP_TURNSTILE_SITE_KEY" \
    --build-arg NEXT_PUBLIC_TIME_ZONE="${SHOP_TIME_ZONE:-UTC}" \
    --build-arg NEXT_PUBLIC_API_PUBLIC_URL="${SHOP_API_PUBLIC_URL:-}" \
    "$dir" || return 1
  compose up -d site || {
    put_back shop "$image" "$from" site
    return 1
  }
  wait_healthy site || {
    say "the shop is not healthy within $HEALTH_WAIT s"
    put_back shop "$image" "$from" site
    return 1
  }
}

# Deploys the newest commit of a part when it may. Returns 1 only when a deploy was tried and failed.
consider() { # <part> [force]
  local part=$1 force=${2:-} dir repo target deployed bad state log
  dir=$(dir_of "$part") || return 0
  repo=$(repo_of "$part") || return 0
  if ! git -C "$dir" fetch --quiet origin "$BRANCH"; then
    say "$part: cannot fetch from GitHub"
    return 0
  fi
  target=$(git -C "$dir" rev-parse "origin/$BRANCH") || return 0
  deployed=$(deployed_of "$part") || return 0
  [ "$target" = "$deployed" ] && return 0
  bad=$(cat "$STATE/$part.bad" 2>/dev/null || true)
  [ "$target" = "$bad" ] && [ -z "$force" ] && return 0
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    say "$part: the checkout has local changes: not deploying"
    return 0
  fi
  if ! git -C "$dir" merge-base --is-ancestor "$deployed" "$target"; then
    say "$part: $BRANCH no longer continues the commit that runs (${deployed:0:7}): deploy by hand"
    return 0
  fi
  if [ -z "$force" ]; then
    state=$(ci_state_spaced "$part" "$repo" "$target")
    case "$state" in
      success) ;;
      pending)
        say "$part: ${target:0:7} waits for its checks"
        return 0
        ;;
      failure)
        say "$part: the checks of ${target:0:7} failed: not deployed"
        return 0
        ;;
      none)
        say "$part: ${target:0:7} has no check results yet"
        return 0
        ;;
      *)
        say "$part: GitHub did not answer about ${target:0:7}"
        return 0
        ;;
    esac
  fi
  if ! relevant "$part" "$deployed" "$target"; then
    git -C "$dir" checkout -q --detach "$target" || return 0
    echo "$target" >"$STATE/$part.deployed"
    say "$part: ${target:0:7} changes nothing that runs: recorded, nothing built"
    return 0
  fi
  log="$STATE/log/$part-$(date -u +%Y%m%dT%H%M%SZ)-${target:0:7}.log"
  say "$part: deploying ${target:0:7} (${deployed:0:7} runs now); log: $log"
  if "deploy_$part" "$deployed" "$target" >"$log" 2>&1; then
    echo "$target" >"$STATE/$part.deployed"
    rm -f "$STATE/$part.bad"
    say "$part: ${target:0:7} runs"
    return 0
  fi
  echo "$target" >"$STATE/$part.bad"
  # The checkout goes back to the commit that runs, and the backend's version line with it.
  git -C "$dir" checkout -q --detach "$deployed" || true
  if [ "$part" = backend ]; then set_version "$deployed" || true; fi
  tail -n 15 "$log" || true
  say "$part: THE DEPLOY OF ${target:0:7} FAILED; ${deployed:0:7} keeps running. Push a fix, or run: gsm-auto-deploy retry $part"
  return 1
}

status() {
  local part dir target deployed
  [ -f "$STATE/hold" ] && echo "ON HOLD: $(cat "$STATE/hold")"
  for part in $PARTS; do
    dir=$(dir_of "$part")
    git -C "$dir" fetch --quiet origin "$BRANCH" 2>/dev/null || echo "$part: cannot fetch from GitHub"
    deployed=$(deployed_of "$part")
    target=$(git -C "$dir" rev-parse "origin/$BRANCH" 2>/dev/null || echo "?")
    echo "$part: runs ${deployed:0:7} ($(git -C "$dir" log -1 --format=%s "$deployed" 2>/dev/null | cut -c1-70))"
    if [ "$target" != "$deployed" ]; then
      echo "  newest on $BRANCH: ${target:0:7}; checks: $(ci_state "$(repo_of "$part")" "$target")"
      if [ "$(cat "$STATE/$part.bad" 2>/dev/null || true)" = "$target" ]; then
        echo "  its deploy failed; after a look: gsm-auto-deploy retry $part"
      fi
    fi
  done
  return 0
}

need_part() {
  if ! dir_of "${1:-}" >/dev/null; then
    echo "auto-deploy: name the part: backend, console or shop" >&2
    exit 2
  fi
}

# A CDN needs all four settings: with the header alone, "compose up" would start Caddy with the repository's file, which trusts
# no proxy, and the API would see the CDN's addresses as every visitor's.
check_settings() {
  [ -n "$CDN_HEADER" ] || return 0
  if [ -z "${CDN_RANGES:-}" ] || [ -z "${EDGE_CADDYFILE:-}" ] || [ -z "$COMPOSE_OVERRIDE" ] || [ ! -r "$COMPOSE_OVERRIDE" ]; then
    echo "auto-deploy: CDN_HEADER is set, so CDN_RANGES, EDGE_CADDYFILE and a readable COMPOSE_OVERRIDE must be set too ($CONF)" >&2
    exit 2
  fi
}

# Tests read the functions above without running a command.
if [ "${GSM_DEPLOY_SOURCED:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

mkdir -p "$STATE/log"
case "${1:-run}" in
  run | retry | force)
    check_settings
    exec 9>"$STATE/lock"
    if ! flock -n 9; then
      say "another run is still going on"
      exit 0
    fi
    failed=0
    case "${1:-run}" in
      retry)
        need_part "${2:-}"
        rm -f "$STATE/$2.bad" "$STATE/$2.asked"
        consider "$2" || failed=1
        ;;
      force)
        need_part "${2:-}"
        rm -f "$STATE/$2.bad"
        consider "$2" force || failed=1
        ;;
      *)
        if [ -f "$STATE/hold" ]; then
          say "on hold: $(cat "$STATE/hold")"
          exit 0
        fi
        for part in $PARTS; do
          consider "$part" || failed=1
        done
        ;;
    esac
    # The forty newest deploy logs stay.
    find "$STATE/log" -maxdepth 1 -name '*.log' -printf '%T@ %p\n' | sort -rn | tail -n +41 | cut -d' ' -f2- | xargs -r rm -f || true
    exit "$failed"
    ;;
  status) status ;;
  hold)
    shift || true
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${*:-no reason given}" >"$STATE/hold"
    echo "Automatic deploys are on hold."
    ;;
  resume)
    rm -f "$STATE/hold"
    echo "Automatic deploys run again."
    ;;
  *)
    echo "usage: auto-deploy.sh run | status | hold [reason] | resume | retry <part> | force <part>" >&2
    exit 2
    ;;
esac
