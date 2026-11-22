#!/usr/bin/env bash
# Nightly database backup (decisions 036 and 055): pg_dump (custom format) -> age -> offsite bucket. The dump is written to a work file,
# where every stage of the pipeline must have succeeded, then copied to db/incoming/, checked there and only then copied to db/daily/ (and
# db/monthly/ on the 1st), so the daily folder holds complete dumps only. This key deletes nothing: retention is the bucket's lifecycle
# rule (docs/OPERATIONS.md section 4). BACKUP_PRUNE=1 keeps the old pruning for a provider without lifecycle rules.
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
prune=${BACKUP_PRUNE:-0}
[[ $prune == 0 || $prune == 1 ]] || die "BACKUP_PRUNE must be 0 or 1"
[[ $retention_days =~ ^[0-9]+$ && $retention_days -ge 1 ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days, at least 1"
[[ $monthly_keep =~ ^[0-9]+$ && $monthly_keep -ge 1 ]] || die "BACKUP_MONTHLY_KEEP must be a whole number, at least 1"

stamp=$(utc_stamp)
incoming="backup:$BACKUP_BUCKET/db/incoming"
daily="backup:$BACKUP_BUCKET/db/daily"
monthly="backup:$BACKUP_BUCKET/db/monthly"

# The dump is made into a file first, so a dump that fails midway is never uploaded: with pipefail the script stops before the copy.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  name="gsm-$stamp.dump.age"
  log dump "dumping to $name (encrypted for the age recipient)"
  run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
    | run age -r "$BACKUP_AGE_RECIPIENT" > "$work/$name" || die "the dump or its encryption failed: nothing was uploaded"
elif [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = 1 ]; then
  name="gsm-$stamp.dump"
  log dump "dumping to $name WITHOUT encryption (BACKUP_ALLOW_PLAINTEXT=1)"
  run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$work/$name" \
    || die "the dump failed: nothing was uploaded"
else
  die "BACKUP_AGE_RECIPIENT is not set: refusing to upload an unencrypted dump (set BACKUP_ALLOW_PLAINTEXT=1 to override)"
fi
dry_run || [ -s "$work/$name" ] || die "the dump file is empty: nothing was uploaded"

log upload "copying $name to the incoming dumps"
run rclone copyto "$work/$name" "$incoming/$name"

# The object must exist and not be empty, or the run fails (a silent empty upload is the classic backup failure).
if dry_run; then
  log verify "dry run: skipping the size check of $name"
else
  size=$(rclone lsf --files-only --format sp --separator ';' "$incoming/" | awk -F';' -v n="$name" '$2 == n { print $1 }')
  [[ ${size:-0} =~ ^[0-9]+$ && ${size:-0} -gt 0 ]] || die "uploaded object $name is missing or empty"
  log verify "$name uploaded, $size bytes"
fi

log publish "copying $name to the daily dumps"
run rclone copyto "$incoming/$name" "$daily/$name"

if [ "$(utc_day)" = 01 ]; then
  log monthly "first of the month: keeping a monthly copy of $name"
  run rclone copyto "$incoming/$name" "$monthly/$name"
fi

if [ "$prune" = 1 ]; then
  log prune "deleting daily dumps older than ${retention_days} days"
  run rclone delete "$daily" --min-age "${retention_days}d"
  run rclone delete "$incoming" --min-age 2d

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
else
  log prune "nothing deleted: the bucket's lifecycle rules keep the dumps (docs/OPERATIONS.md section 4)"
fi

log done "backup $name complete"
