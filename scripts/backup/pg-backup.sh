#!/usr/bin/env bash
# Nightly database backup (feature 24D, decision 036): pg_dump (custom format) -> age -> offsite S3 bucket, with retention.
# Needs DATABASE_URL, BACKUP_S3_* and BACKUP_AGE_RECIPIENT (an age public key; BACKUP_ALLOW_PLAINTEXT=1 to skip encryption).
# BACKUP_DRY_RUN=1 prints every command instead of running it. Exit code is non-zero on any failure.
set -euo pipefail
SCRIPT_NAME=pg-backup
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_vars DATABASE_URL
setup_backup_remote

retention_days=${BACKUP_RETENTION_DAYS:-30}
monthly_keep=${BACKUP_MONTHLY_KEEP:-12}
[[ $retention_days =~ ^[0-9]+$ && $retention_days -ge 1 ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days, at least 1"
[[ $monthly_keep =~ ^[0-9]+$ && $monthly_keep -ge 1 ]] || die "BACKUP_MONTHLY_KEEP must be a whole number, at least 1"

stamp=$(utc_stamp)
daily="backup:$BACKUP_BUCKET/db/daily"
monthly="backup:$BACKUP_BUCKET/db/monthly"

# A dump that fails mid-stream can leave a partial object behind; the restore drill takes the newest object, so delete it on any
# failure exit. `uploaded` turns 1 only after the size check passed.
uploaded=0
cleanup_partial() {
  if [ "$uploaded" != 1 ] && [ -n "${name:-}" ] && ! dry_run; then
    rclone deletefile "$daily/$name" >/dev/null 2>&1 || true
  fi
}
trap cleanup_partial EXIT

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  name="gsm-$stamp.dump.age"
  log dump "dumping to $name (encrypted for the age recipient)"
  run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
    | run age -r "$BACKUP_AGE_RECIPIENT" \
    | run rclone rcat "$daily/$name"
elif [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = 1 ]; then
  name="gsm-$stamp.dump"
  log dump "dumping to $name WITHOUT encryption (BACKUP_ALLOW_PLAINTEXT=1)"
  run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
    | run rclone rcat "$daily/$name"
else
  die "BACKUP_AGE_RECIPIENT is not set: refusing to upload an unencrypted dump (set BACKUP_ALLOW_PLAINTEXT=1 to override)"
fi

# The object must exist and not be empty, or the run fails (a silent empty upload is the classic backup failure).
if dry_run; then
  log verify "dry run: skipping the size check of $name"
else
  size=$(rclone lsf --files-only --format sp --separator ';' "$daily/" | awk -F';' -v n="$name" '$2 == n { print $1 }')
  [[ ${size:-0} =~ ^[0-9]+$ && ${size:-0} -gt 0 ]] || die "uploaded object $name is missing or empty"
  log verify "$name uploaded, $size bytes"
fi
uploaded=1

if [ "$(utc_day)" = 01 ]; then
  log monthly "first of the month: keeping a monthly copy of $name"
  run rclone copyto "$daily/$name" "$monthly/$name"
fi

log prune "deleting daily dumps older than ${retention_days} days"
run rclone delete "$daily" --min-age "${retention_days}d"

# Monthly copies: keep the newest $monthly_keep. Names carry a UTC stamp, so the name order is the age order.
if dry_run; then
  log prune "dry run: monthly copies beyond the newest $monthly_keep would be deleted"
else
  old=$(rclone lsf --files-only "$monthly/" | sort | head -n "-$monthly_keep" || true)
  while IFS= read -r object; do
    [ -n "$object" ] || continue
    log prune "deleting monthly copy $object"
    rclone deletefile "$monthly/$object"
  done <<<"$old"
fi

log done "backup $name complete"
