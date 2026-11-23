#!/usr/bin/env bash
# Shared helpers of the backup scripts (feature 24D, decision 036). Sourced, never run. Bash 5 (the postgres:18 base image).
# Every external command goes through `run` so BACKUP_DRY_RUN=1 prints the command instead of executing it.

# Timestamp of "now" in UTC, as 20261110T011500Z. BACKUP_NOW (any `date -d` string) pins it for tests and for re-runs of a day.
utc_stamp() {
  date -u -d "${BACKUP_NOW:-now}" +%Y%m%dT%H%M%SZ
}

# Day of the month (01-31) in UTC; the first of the month also keeps a monthly copy.
utc_day() {
  date -u -d "${BACKUP_NOW:-now}" +%d
}

# One JSON line per step on stdout: log <step> <message>.
log() {
  local step=$1 message=$2
  message=${message//\\/\\\\}
  message=${message//\"/\\\"}
  printf '{"ts":"%s","script":"%s","step":"%s","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$step" "$message"
}

# Stops the script with a message and exit code 1.
die() {
  log error "$1" >&2
  exit 1
}

dry_run() {
  [ "${BACKUP_DRY_RUN:-0}" = 1 ]
}

# Hides the password of connection URLs in anything that is printed.
redact() {
  sed -E 's#(://[^:/@ ]+):[^@ ]*@#\1:***@#g'
}

# Prints one argument as shell text: bare when it is made of safe characters, else in single quotes.
quote_arg() {
  if [[ $1 =~ ^[A-Za-z0-9_@%+=:,./*-]+$ ]]; then
    printf '%s' "$1"
  else
    printf "'%s'" "${1//\'/\'\\\'\'}"
  fi
}

# Runs a command, or in a dry run prints it (to stderr, so a pipeline of `run` stages stays a pipeline) and succeeds.
# The line is built first and written once, so the stages of a pipeline, which run at the same time, never interleave.
run() {
  if dry_run; then
    local line="+" arg
    for arg in "$@"; do
      line+=" $(quote_arg "$arg")"
    done
    printf '%s\n' "$(printf '%s' "$line" | redact)" >&2
    return 0
  fi
  "$@"
}

# Fails with the list of missing variables: require_vars NAME...
require_vars() {
  local missing=() name
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing required variables: ${missing[*]}"
}

# Defines the rclone remote `backup:` (the offsite bucket) from BACKUP_S3_* through RCLONE_CONFIG_* variables, so no config
# file with secrets exists anywhere.
setup_backup_remote() {
  require_vars BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
  export RCLONE_CONFIG_BACKUP_TYPE=s3
  export RCLONE_CONFIG_BACKUP_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_BACKUP_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_BACKUP_REGION="${BACKUP_S3_REGION:-}"
  # The bucket is created by the owner; rclone must not try to create it (the key may lack the permission).
  export RCLONE_CONFIG_BACKUP_NO_CHECK_BUCKET=true
  # Cloudflare R2 answers an upload with a version id but refuses every request that names one (it keeps no versions), so the read-back
  # rclone makes after an upload fails there and only its retry passes. Without the read-back the upload is still checked: the provider
  # compares the body with the Content-MD5 rclone sends, and the scripts look at the stored object themselves (decision 059).
  if [ "${BACKUP_S3_PROVIDER:-Other}" = Cloudflare ]; then
    export RCLONE_CONFIG_BACKUP_NO_HEAD=true
  fi
  BACKUP_BUCKET="$BACKUP_S3_BUCKET"
}

# Defines the rclone remote `files:` (the application's files bucket) from the S3_* variables of the application.
setup_files_remote() {
  require_vars S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  export RCLONE_CONFIG_FILES_TYPE=s3
  export RCLONE_CONFIG_FILES_PROVIDER=Other
  export RCLONE_CONFIG_FILES_ENDPOINT="$S3_ENDPOINT"
  export RCLONE_CONFIG_FILES_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_FILES_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_FILES_REGION="${S3_REGION:-us-east-1}"
  export RCLONE_CONFIG_FILES_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
}
