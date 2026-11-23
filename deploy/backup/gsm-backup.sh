#!/usr/bin/env bash
# The host side of the backups (decision 059, docs/OPERATIONS.md section 4). Installed as /usr/local/sbin/gsm-backup and run by root:
# a systemd timer calls "run" every night and another one "check" every morning; a person calls "status" and, once a month, "drill".
#
#   run                     the nightly backup, in four steps; a step that fails does not stop the next ones:
#                             image     builds the tools image of the checkout (a failed build is a warning while an image exists)
#                             database  pg-backup.sh: the encrypted dump to db/daily/ (and db/monthly/ on the first of the month)
#                             files     files-mirror.sh: the encrypted copy of the files bucket in files-age/
#                             config    the server's own configuration, packed and encrypted HERE with age for BACKUP_AGE_RECIPIENT,
#                                       then stored in config/ by config-copy.sh: the container never sees the plaintext (symbolic
#                                       links are followed: the copy holds the files' content)
#                           The output of the steps goes to $STATE/log/run-<UTC stamp>.log (the 60 newest stay). $STATE/last-run says
#                           "failed, interrupted" from the moment the lock is taken, and the end of the run overwrites it; when every
#                           step passed also $STATE/last-success and a GET of HEARTBEAT_URL; otherwise one alert and exit code 1. A run
#                           stopped by TERM, INT or HUP sends one alert naming the step it was in, and exits 1. A second run while one
#                           is going on prints a line and exits 75 (only a busy lock does: any other lock failure is an error).
#   check                   reads the bucket (offsite-status.sh), not a note of this server: one alert and exit code 1 when the
#                           listing fails, when there is no daily dump, when the newest one is older than MAX_AGE_HOURS (read from its
#                           name), dated more than an hour in the future, or empty, or when the last run failed or was interrupted
#                           (not while a run holds the lock), or when a copy of the private key was left outside a drill (it is
#                           removed). A reminder alert, and still exit code 0, when the restore drill is due (no drill recorded, or
#                           none for DRILL_EVERY_DAYS).
#   status                  for a person: the last run, success and drill, what the bucket holds, the timers' next times
#   drill <age identity>    the monthly restore drill with the offline private key: a copy for the container, ALWAYS removed after
#                           (one drill at a time: $STATE/drill.lock)
#
# Alerts: one line on standard error (the journal) and, with ALERT_EMAIL, one plain-text mail through the application's own SMTP
# account (MAIL_SMTP_URL and MAIL_FROM of .env.production, read and never sourced). A mail that cannot be sent is a line in the log
# and never changes the exit code. No secret is printed or logged: the SMTP credentials and the heartbeat address reach curl through a
# config on its standard input, never through its arguments. Works without a terminal.
# Settings: /etc/gsm-backup.conf (GSM_BACKUP_CONF overrides the path; template deploy/backup/gsm-backup.conf.example). Needs docker,
# curl, flock and age on the host. GSM_BACKUP_NOW (any "date -d" string) pins "now" for tests.
#
# Inside the functions every step is checked by hand ("|| return 1"): bash does not stop a function at a failing command when the
# function is called in a condition, and every step is.
set -euo pipefail
umask 077

CONF=${GSM_BACKUP_CONF:-/etc/gsm-backup.conf}
[[ $CONF == /* ]] || CONF=$PWD/$CONF

settings_error() {
  echo "gsm-backup: $*" >&2
  exit 2
}

usage() {
  echo "usage: gsm-backup run | check | status | drill <age identity file>" >&2
  exit 2
}

[ -r "$CONF" ] || settings_error "cannot read $CONF (template: deploy/backup/gsm-backup.conf.example)"
# shellcheck disable=SC1090
. "$CONF"
ROOT=${ROOT:-}
COMPOSE_OVERRIDE=${COMPOSE_OVERRIDE:-}
STATE=${STATE:-/var/lib/gsm-backup}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-26}
DRILL_EVERY_DAYS=${DRILL_EVERY_DAYS:-35}
ALERT_EMAIL=${ALERT_EMAIL:-}
HEARTBEAT_URL=${HEARTBEAT_URL:-}
CONFIG_PATHS=${CONFIG_PATHS:-}
# The image the compose file names for the backup service.
IMAGE=gsm-backup:local

# Every setting is checked before anything runs; a wrong one stops with exit code 2. The values of HEARTBEAT_URL and ALERT_EMAIL are
# not repeated in the messages.
check_settings() {
  local path paths=() email='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$' https='^https://[^[:space:]"\\]+$'
  [ -n "$ROOT" ] || settings_error "set ROOT in $CONF: the folder that holds the backend checkout"
  [ -r "$ROOT/backend/deploy/compose.prod.yaml" ] || settings_error "ROOT=$ROOT does not hold the backend checkout ($ROOT/backend/deploy/compose.prod.yaml not found)"
  [ -r "$ROOT/backend/deploy/.env" ] || settings_error "cannot read $ROOT/backend/deploy/.env (the backups read their bucket and key there)"
  [ -z "$COMPOSE_OVERRIDE" ] || [ -r "$COMPOSE_OVERRIDE" ] || settings_error "cannot read COMPOSE_OVERRIDE=$COMPOSE_OVERRIDE"
  [[ $STATE == /* ]] || settings_error "STATE must be an absolute path"
  [[ $MAX_AGE_HOURS =~ ^[1-9][0-9]*$ ]] || settings_error "MAX_AGE_HOURS must be a whole number of hours, at least 1"
  [[ $DRILL_EVERY_DAYS =~ ^[1-9][0-9]*$ ]] || settings_error "DRILL_EVERY_DAYS must be a whole number of days, at least 1"
  [ -z "$ALERT_EMAIL" ] || [[ $ALERT_EMAIL =~ $email ]] || settings_error "ALERT_EMAIL must be one e-mail address"
  [ -z "$HEARTBEAT_URL" ] || [[ $HEARTBEAT_URL =~ $https ]] || settings_error "HEARTBEAT_URL must be an https:// address without spaces or quotes"
  read -r -a paths <<<"$CONFIG_PATHS"
  for path in ${paths[@]+"${paths[@]}"}; do
    [[ $path == /* ]] || settings_error "CONFIG_PATHS holds absolute paths separated by spaces; not one: $path"
  done
  NOW=$(date -u -d "${GSM_BACKUP_NOW:-now}" +%s 2>/dev/null) || settings_error "GSM_BACKUP_NOW is not a date"
  STAMP=$(date -u -d "@$NOW" +%Y%m%dT%H%M%SZ)
  NOW_ISO=$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)
}

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# A line for the journal and, during a run, for the run's log too.
RUN_LOG=""
note() {
  say "$*" >&2
  [ -z "$RUN_LOG" ] || say "$*" >>"$RUN_LOG"
}

compose() {
  local files=(-f "$ROOT/backend/deploy/compose.prod.yaml")
  [ -z "$COMPOSE_OVERRIDE" ] || files+=(-f "$COMPOSE_OVERRIDE")
  docker compose "${files[@]}" --env-file "$ROOT/backend/deploy/.env" "$@"
}

# The value of a variable of an env file (NAME=value lines), without surrounding quotes or a trailing comment; empty when it is not
# set (the last line wins, as for compose). The file is read, never sourced: its values are data, and it is not this script's file.
value_of() { # <file> <name>
  local line
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -n 1) || true
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#"${line%%[![:space:]]*}"}
  case $line in
    \"*)
      line=${line#\"}
      line=${line%%\"*}
      ;;
    \'*)
      line=${line#\'}
      line=${line%%\'*}
      ;;
    *) line=$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
  esac
  printf '%s\n' "$line"
}

# One key of a state file of $STATE (key=value lines); empty when the file or the key is missing.
state_value() { # <file> <key>
  sed -n "s/^$2=//p" "$STATE/$1" 2>/dev/null | tail -n 1 || true
}

# A string as a double-quoted value of a curl config file.
curl_quoted() {
  local value=${1//\\/\\\\}
  printf '"%s"' "${value//\"/\\\"}"
}

# Sends one plain-text mail to ALERT_EMAIL through the application's SMTP account; a reason on standard output when it cannot. The
# address with its credentials goes to curl in a config on standard input, so no process listing and no log shows them.
send_mail() { # <subject> <body>
  local env=$ROOT/backend/.env.production url from sender message code=0 tls=()
  url=$(value_of "$env" MAIL_SMTP_URL)
  from=$(value_of "$env" MAIL_FROM)
  if [ -z "$url" ] || [ -z "$from" ]; then
    echo "MAIL_SMTP_URL or MAIL_FROM is not set in $env"
    return 1
  fi
  case $url in
    smtps://*) ;;
    smtp://*) tls=(--ssl-reqd) ;;
    *)
      echo "MAIL_SMTP_URL of $env is neither smtps:// nor smtp://"
      return 1
      ;;
  esac
  # Options of the application's mailer after "?" mean nothing to curl.
  url=${url%%\?*}
  sender=$from
  [[ $from =~ \<([^\<\>]+)\> ]] && sender=${BASH_REMATCH[1]}
  message=$(mktemp "$STATE/mail.XXXXXX") || return 1
  {
    printf 'From: %s\n' "$from"
    printf 'To: %s\n' "$ALERT_EMAIL"
    printf 'Subject: %s\n' "$1"
    printf 'Date: %s\n' "$(date -R)"
    printf 'MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\n'
    printf '%s\n' "$2"
  } >"$message"
  printf 'url = %s\n' "$(curl_quoted "$url")" |
    curl -sS -m 30 --crlf ${tls[@]+"${tls[@]}"} --mail-from "$sender" --mail-rcpt "$ALERT_EMAIL" --upload-file "$message" -K - 2>&1 ||
    code=$?
  rm -f "$message"
  return "$code"
}

# One alert: a line on standard error, and one mail when ALERT_EMAIL is set. Never fails.
alert() { # <subject> <body>
  local subject reason
  subject="[backup] $(hostname 2>/dev/null || echo server): $1"
  printf 'gsm-backup: ALERT %s: %s\n' "$subject" "$(printf '%s' "$2" | tr '\n' ' ')" >&2
  [ -n "$ALERT_EMAIL" ] || return 0
  if ! reason=$(send_mail "$subject" "$2"); then
    note "the alert mail could not be sent: $(printf '%s' "$reason" | tr '\n' ' ' | cut -c1-300)"
  fi
  return 0
}

# A GET of HEARTBEAT_URL, for a monitor outside the server that warns when a night passes without one. A failure is a warning only.
heartbeat() {
  [ -n "$HEARTBEAT_URL" ] || return 0
  if printf 'url = %s\n' "$(curl_quoted "$HEARTBEAT_URL")" | curl -fsS -m 30 -o /dev/null -K - >/dev/null 2>&1; then
    note "heartbeat sent"
  else
    note "warning: the heartbeat address did not answer (the backup itself succeeded)"
  fi
}

IMAGE_WARNING=0
step_image() {
  if compose build backup; then
    return 0
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "the build of the backup image failed: the existing $IMAGE is used"
    IMAGE_WARNING=1
    return 0
  fi
  echo "the build of the backup image failed and there is no $IMAGE image"
  return 1
}

step_database() {
  compose run --rm -T backup pg-backup.sh
}

step_files() {
  compose run --rm -T backup files-mirror.sh
}

# The paths of the configuration copy, one per line: CONFIG_PATHS, or the default list.
config_paths() {
  local paths=()
  if [ -n "$CONFIG_PATHS" ]; then
    read -r -a paths <<<"$CONFIG_PATHS"
  else
    paths=("$ROOT/backend/deploy/.env" "$ROOT/backend/.env.production" "$CONF" "${GSM_DEPLOY_CONF:-/etc/gsm-deploy.conf}" "$ROOT/server")
  fi
  printf '%s\n' "${paths[@]}"
}

CONFIG_WORK=""
step_config() {
  local recipient path kept=() name code=0
  recipient=$(value_of "$ROOT/backend/deploy/.env" BACKUP_AGE_RECIPIENT)
  if [ -z "$recipient" ] || [[ $recipient == CHANGE* ]]; then
    echo "BACKUP_AGE_RECIPIENT is not set in $ROOT/backend/deploy/.env: set it to the backups' age public key (docs/OPERATIONS.md section 4); nothing was copied"
    return 1
  fi
  if ! command -v age >/dev/null 2>&1; then
    echo "age is not installed on this server: install it (apt-get install age); the configuration is encrypted here, never in the container; nothing was copied"
    return 1
  fi
  while IFS= read -r path; do
    if [ -e "$path" ]; then
      kept+=("${path#/}")
    else
      echo "not in the copy (it does not exist): $path"
    fi
  done < <(config_paths)
  if [ ${#kept[@]} -eq 0 ]; then
    echo "none of the configuration paths exists: nothing was copied"
    return 1
  fi
  name="gsm-config-$STAMP.tar.gz.age"
  CONFIG_WORK=$(mktemp -d "$STATE/config.XXXXXX") || return 1
  # Packed and encrypted in one pipe, so the plaintext never touches a disk. The encrypted file is complete before the container
  # starts: with pipefail a tar or an age that fails leaves nothing to send. -h: a settings file that is a symbolic link is copied
  # with its content; a link alone would restore nothing.
  if ! tar -C / -chzf - "${kept[@]}" | age -r "$recipient" >"$CONFIG_WORK/$name"; then
    echo "packing or encrypting the configuration failed: nothing was copied"
    rm -rf "$CONFIG_WORK"
    CONFIG_WORK=""
    return 1
  fi
  printf 'packed and encrypted on the host:'
  printf ' /%s' "${kept[@]}"
  printf '\n'
  compose run --rm -T backup config-copy.sh "$name" <"$CONFIG_WORK/$name" || code=$?
  rm -rf "$CONFIG_WORK"
  CONFIG_WORK=""
  return "$code"
}

# Keeps the newest <count> logs of one kind; the names carry the UTC stamp, so the name order is the age order.
rotate_logs() { # <kind> <count>
  find "$STATE/log" -maxdepth 1 -name "$1-*.log" -printf '%f\n' | LC_ALL=C sort -r | tail -n +"$(($2 + 1))" |
    while IFS= read -r old; do rm -f "$STATE/log/$old"; done || true
}

# Takes a lock for the rest of the process (the children inherit it): 0 taken, 75 busy (another process still holds it after a wait
# of GSM_BACKUP_LOCK_WAIT seconds, 5 by default: the morning check holds a lock for an instant when it looks whether a run is going
# on, and a run that starts in that instant must not be turned away), 1 any other failure, with a message.
take_lock() { # <file>
  local fd code=0
  if ! exec {fd}>"$1"; then
    echo "gsm-backup: cannot open the lock file $1" >&2
    return 1
  fi
  flock -w "${GSM_BACKUP_LOCK_WAIT:-5}" "$fd" || code=$?
  case $code in
    0) return 0 ;;
    1) return 75 ;;
    *)
      echo "gsm-backup: the lock $1 could not be taken (flock exit code $code)" >&2
      return 1
      ;;
  esac
}

# Whether another process holds a lock file now. A lock file that is missing or cannot be read counts as free.
lock_busy() { # <file>
  local code=0
  [ -e "$1" ] || return 1
  flock -n "$1" true 2>/dev/null || code=$?
  [ "$code" -eq 1 ]
}

write_last_run() { # <result> <failed steps> <dump> <seconds>
  printf 'at=%s\nresult=%s\nfailed_steps=%s\ndump=%s\nseconds=%s\n' "$NOW_ISO" "$1" "$2" "$3" "$4" >"$STATE/last-run.new" &&
    mv -f "$STATE/last-run.new" "$STATE/last-run"
}

# The run's progress, for the signal trap, and the standard output and error of the run (the journal).
CURRENT_STEP=""
RUN_OUT=1
RUN_ERR=2
RUN_FAILED=()
RUN_STARTED=0

# A run stopped by a signal (a shutdown, systemctl stop, Ctrl-C) records it and sends one alert, then exits 1. Bash runs this once the
# command in the foreground has ended; the EXIT trap still removes the configuration's work folder.
on_interrupt() {
  local steps=interrupted
  trap '' HUP INT TERM
  set +e
  # The trap runs inside the step's redirection to the log: speak to the journal again.
  exec 1>&"$RUN_OUT" 2>&"$RUN_ERR"
  [ ${#RUN_FAILED[@]} -eq 0 ] || steps="$(
    IFS=,
    echo "${RUN_FAILED[*]}"
  ),interrupted"
  write_last_run failed "$steps" "" "$((SECONDS - RUN_STARTED))"
  printf '== %s interrupted during the step %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CURRENT_STEP:-none}" >>"$RUN_LOG"
  say "THE BACKUP RUN WAS INTERRUPTED during the step ${CURRENT_STEP:-none}; log: $RUN_LOG" 2>/dev/null
  alert "the nightly backup was interrupted" "The backup run of $NOW_ISO was stopped by a signal during the step ${CURRENT_STEP:-none};
the steps after it did not run.

Log on the server: $RUN_LOG
State: $STATE/last-run
Look with: gsm-backup status; start a run by hand when the server is quiet: systemctl start gsm-backup.service

docs/OPERATIONS.md section 4."
  exit 1
}

cmd_run() {
  local step result dump steps code=0
  take_lock "$STATE/lock" || code=$?
  if [ "$code" -eq 75 ]; then
    say "another backup run is still going on"
    exit 75
  fi
  [ "$code" -eq 0 ] || exit 1
  RUN_STARTED=$SECONDS
  # Until the end of the run says otherwise, the run counts as interrupted: a run that is killed without a chance to say so (SIGKILL,
  # a power loss) leaves this behind, and the morning check reports it.
  if ! write_last_run failed interrupted "" 0; then
    echo "gsm-backup: cannot write $STATE/last-run" >&2
    exit 1
  fi
  trap '[ -z "$CONFIG_WORK" ] || rm -rf "$CONFIG_WORK"' EXIT
  RUN_LOG=$STATE/log/run-$STAMP.log
  : >"$RUN_LOG"
  exec {RUN_OUT}>&1 {RUN_ERR}>&2
  trap on_interrupt HUP INT TERM
  say "backup run $STAMP; log: $RUN_LOG"
  for step in image database files config; do
    CURRENT_STEP=$step
    printf '== %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" >>"$RUN_LOG"
    if "step_$step" >>"$RUN_LOG" 2>&1; then
      say "$step: ok"
    else
      say "$step: FAILED"
      RUN_FAILED+=("$step")
    fi
  done
  trap '' HUP INT TERM
  CURRENT_STEP=""
  [ "$IMAGE_WARNING" = 0 ] || say "warning: the backup image was not rebuilt (the last one was used): see the log"
  dump=$(sed -n -E 's/.*"script":"pg-backup","step":"done","msg":"backup ([^" ]+) complete".*/\1/p' "$RUN_LOG" | tail -n 1) || dump=""
  steps=$(
    IFS=,
    echo "${RUN_FAILED[*]}"
  )
  result=ok
  [ ${#RUN_FAILED[@]} -eq 0 ] || result=failed
  write_last_run "$result" "$steps" "$dump" "$((SECONDS - RUN_STARTED))"
  rotate_logs run 60
  if [ "$result" = ok ]; then
    cp -f "$STATE/last-run" "$STATE/last-success"
    say "backup complete: $dump"
    heartbeat
    exit 0
  fi
  say "BACKUP FAILED: $steps; log: $RUN_LOG"
  alert "the nightly backup failed ($steps)" "The backup run of $NOW_ISO failed in these steps: ${steps//,/, }.
The other steps ran.

Log on the server: $RUN_LOG
State: $STATE/last-run
Look with: gsm-backup status

docs/OPERATIONS.md section 4 describes the steps."
  exit 1
}

# What offsite-status.sh printed, by key. Fails when a count is missing or not a number.
declare -A OFFSITE=()
read_offsite() { # <output of offsite-status.sh>
  local key value
  OFFSITE=()
  while IFS='=' read -r key value; do
    case $key in
      daily_count | daily_newest | daily_newest_bytes | monthly_count | monthly_newest | monthly_newest_bytes | config_count | \
        config_newest | config_newest_bytes | files_count) OFFSITE[$key]=$value ;;
    esac
  done <<<"$1"
  for key in daily_count monthly_count config_count files_count; do
    [[ ${OFFSITE[$key]:-} =~ ^[0-9]+$ ]] || return 1
  done
}

# Lists the bucket in the container (no database needed, so none is started). Prints its output; fails when the listing fails.
offsite_status() {
  local err out
  err=$(mktemp "$STATE/status.XXXXXX") || return 1
  if ! out=$(compose run --rm --no-deps -T backup offsite-status.sh 2>"$err"); then
    tail -n 5 "$err" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  printf '%s\n' "$out"
}

# The epoch seconds of a daily dump's name (gsm-<YYYYMMDDTHHMMSSZ>.dump.age); fails for any other name.
dump_epoch() { # <name>
  [[ $1 =~ ^gsm-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump\.age$ ]] || return 1
  date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]} UTC" +%s 2>/dev/null
}

# Prints why the restore drill is due; fails when it is not.
drill_due() {
  local at made
  if [ ! -s "$STATE/last-drill" ]; then
    echo "no restore drill is recorded on this server"
    return 0
  fi
  at=$(state_value last-drill at)
  if ! made=$(date -u -d "$at" +%s 2>/dev/null); then
    echo "the date of the last restore drill cannot be read"
    return 0
  fi
  if ((NOW - made > DRILL_EVERY_DAYS * 86400)); then
    echo "the last restore drill was $(((NOW - made) / 86400)) days ago ($at)"
    return 0
  fi
  return 1
}

cmd_check() {
  local out problems=() newest bytes made hours="" due found body steps running=""
  # A copy of the private key outside a drill is removed at once, and reported: the key must never stay on the server.
  if [ -e "$STATE/age.key.restore" ] && ! lock_busy "$STATE/drill.lock"; then
    KEY_COPY=$STATE/age.key.restore
    remove_key
    KEY_COPY=""
    problems+=("a copy of the private key was left on the server and has been removed")
  fi
  if ! out=$(offsite_status) || ! read_offsite "$out"; then
    body=""
    [ ${#problems[@]} -eq 0 ] || body=$(printf '%s\n' "${problems[@]}")
    say "check: FAILED: the offsite bucket could not be listed${body:+; $(printf '%s' "$body" | tr '\n' ';')}"
    alert "the offsite bucket could not be listed" "The morning check could not list the offsite bucket, so it cannot tell whether last night's backup is there.
An unreadable bucket is never taken for an empty one.
${body:+$body
}
Try it by hand: gsm-backup status
docs/OPERATIONS.md section 4."
    exit 1
  fi
  newest=${OFFSITE[daily_newest]:-}
  bytes=${OFFSITE[daily_newest_bytes]:-}
  if [ "${OFFSITE[daily_count]}" -eq 0 ]; then
    problems+=("there is no daily dump in the bucket")
  else
    if made=$(dump_epoch "$newest"); then
      # A stamp ahead of now would never look old: a clock that went backwards must not hide the nights that follow.
      if ((made - NOW > 3600)); then
        problems+=("the newest daily dump, $newest, is dated in the future: check the server's clock")
      else
        hours=$(((NOW - made) / 3600))
        if ((NOW - made > MAX_AGE_HOURS * 3600)); then
          problems+=("the newest daily dump, $newest, is $hours hours old (more than $MAX_AGE_HOURS)")
        fi
      fi
    else
      problems+=("the name of the newest daily dump, $newest, carries no date")
    fi
    if ! [[ $bytes =~ ^[0-9]+$ ]] || [ "$bytes" -eq 0 ]; then
      problems+=("the newest daily dump, $newest, is empty")
    fi
  fi
  # A run that holds the lock is still going on: its last-run says "interrupted" until it ends, which is not a problem yet.
  if lock_busy "$STATE/lock"; then
    running="; a backup run is going on now"
  elif [ "$(state_value last-run result)" = failed ]; then
    steps=$(state_value last-run failed_steps)
    if [[ ,$steps, == *,interrupted,* ]]; then
      steps=${steps%interrupted}
      problems+=("the last run, $(state_value last-run at), was interrupted before it finished${steps:+ (failed before that: ${steps%,})}")
    else
      problems+=("the last run, $(state_value last-run at), failed in: $steps")
    fi
  fi
  found="newest daily dump ${newest:-none}${bytes:+, $bytes bytes}${hours:+, $hours hours old}; ${OFFSITE[daily_count]} daily, ${OFFSITE[monthly_count]} monthly, ${OFFSITE[config_count]} configuration copies, ${OFFSITE[files_count]} files$running"
  due=$(drill_due) || due=""
  if [ ${#problems[@]} -gt 0 ]; then
    body=$(printf '%s\n' "${problems[@]}")
    say "check: FAILED: $(printf '%s; ' "${problems[@]}")bucket: $found"
    alert "the backup check failed" "The morning check of the offsite backups found:
$body

In the bucket: $found
${due:+The restore drill is due too: $due.
}
Look with: gsm-backup status (the logs of the runs are in $STATE/log/)
docs/OPERATIONS.md section 4."
    exit 1
  fi
  say "check: ok: $found"
  if [ -n "$due" ]; then
    alert "restore drill due" "The monthly restore drill is due: $due.
With the offline age key at hand, run on the server: gsm-backup drill <age identity file>
(docs/OPERATIONS.md section 4). The key is copied for the drill and removed afterwards."
  fi
  exit 0
}

# Prints one state file as a line: at, result, failed steps, seconds and dump.
show_state() { # <label> <file>
  local at result steps dump seconds
  if [ ! -s "$STATE/$2" ]; then
    printf '%-14s %s\n' "$1:" "never"
    return 0
  fi
  at=$(state_value "$2" at)
  result=$(state_value "$2" result)
  steps=$(state_value "$2" failed_steps)
  dump=$(state_value "$2" dump)
  seconds=$(state_value "$2" seconds)
  printf '%-14s %s, %s%s, %s s%s\n' "$1:" "$at" "$result" "${steps:+ (${steps//,/, })}" "$seconds" "${dump:+, dump $dump}"
}

cmd_status() {
  local out made timer next
  ! lock_busy "$STATE/lock" || echo "a backup run is going on now (its last run line says interrupted until it ends)"
  show_state "last run" last-run
  show_state "last success" last-success
  if [ -s "$STATE/last-drill" ]; then
    printf '%-14s %s with %s\n' "last drill:" "$(state_value last-drill at)" "$(state_value last-drill dump)"
  else
    printf '%-14s %s\n' "last drill:" "never"
  fi
  if out=$(offsite_status) && read_offsite "$out"; then
    printf '%-14s %s daily, %s monthly, %s configuration copies, %s files\n' "offsite:" "${OFFSITE[daily_count]}" \
      "${OFFSITE[monthly_count]}" "${OFFSITE[config_count]}" "${OFFSITE[files_count]}"
    if [ "${OFFSITE[daily_count]}" -eq 0 ]; then
      printf '%-14s %s\n' "newest dump:" "none"
    elif made=$(dump_epoch "${OFFSITE[daily_newest]}"); then
      printf '%-14s %s, %s bytes, %s hours old\n' "newest dump:" "${OFFSITE[daily_newest]}" "${OFFSITE[daily_newest_bytes]}" "$(((NOW - made) / 3600))"
    else
      printf '%-14s %s, %s bytes\n' "newest dump:" "${OFFSITE[daily_newest]}" "${OFFSITE[daily_newest_bytes]}"
    fi
  else
    printf '%-14s %s\n' "offsite:" "THE BUCKET COULD NOT BE LISTED (see the lines above)"
  fi
  if command -v systemctl >/dev/null 2>&1; then
    for timer in gsm-backup gsm-backup-check; do
      next=$(systemctl show "$timer.timer" --property=NextElapseUSecRealtime --value 2>/dev/null) || next=""
      printf '%-14s %s\n' "$timer:" "next ${next:-unknown ($timer.timer is not active)}"
    done
  fi
  [ ! -e "$STATE/age.key.restore" ] || echo "WARNING: a copy of the private key is left at $STATE/age.key.restore: remove it (shred -u)"
  return 0
}

# The copy of the private key for the container; removed after every drill, whatever its end.
KEY_COPY=""
remove_key() {
  [ -n "$KEY_COPY" ] && [ -e "$KEY_COPY" ] || return 0
  shred -u "$KEY_COPY" 2>/dev/null || rm -f "$KEY_COPY"
}

cmd_drill() { # <age identity file>
  local identity=$1 log code dump
  if [ ! -f "$identity" ] || [ ! -r "$identity" ]; then
    echo "gsm-backup: cannot read the identity file $identity" >&2
    exit 2
  fi
  # One drill at a time; the morning check leaves the key copy alone while this lock is held.
  take_lock "$STATE/drill.lock" || code=$?
  if [ "${code:-0}" -eq 75 ]; then
    echo "gsm-backup: another restore drill is going on" >&2
    exit 75
  fi
  [ "${code:-0}" -eq 0 ] || exit 1
  KEY_COPY=$STATE/age.key.restore
  trap remove_key EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The container runs as uid 10001 and reads the key through a read-only mount of this copy.
  if ! install -m 0400 -o 10001 -g 10001 "$identity" "$KEY_COPY"; then
    echo "gsm-backup: the identity could not be copied for the container (run as root)" >&2
    exit 1
  fi
  log=$STATE/log/drill-$STAMP.log
  say "restore drill; log: $log"
  set +e
  compose run --rm -T -v "$KEY_COPY:/age.key:ro" backup restore-drill.sh --identity /age.key 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  set -e
  remove_key
  rotate_logs drill 24
  if [ "$code" -eq 0 ]; then
    dump=$(grep -o 'restore drill passed with [^" ]*' "$log" | tail -n 1 | sed 's/^restore drill passed with //') || dump=""
    printf 'at=%s\ndump=%s\n' "$(date -u -d "${GSM_BACKUP_NOW:-now}" +%Y-%m-%dT%H:%M:%SZ)" "$dump" >"$STATE/last-drill"
    say "restore drill passed with $dump: recorded in $STATE/last-drill"
  else
    say "THE RESTORE DRILL FAILED (exit code $code): see $log"
  fi
  exit "$code"
}

check_settings
mkdir -p "$STATE/log"
case "${1:-}" in
  run) cmd_run ;;
  check) cmd_check ;;
  status) cmd_status ;;
  drill)
    [ $# -eq 2 ] || usage
    cmd_drill "$2"
    ;;
  *) usage ;;
esac
