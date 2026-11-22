#!/usr/bin/env bash
# Encrypted mirror of the files bucket (decisions 036 and 055): every object of the application's bucket that the offsite copy lacks is
# encrypted with age for BACKUP_AGE_RECIPIENT and stored as files-age/<key>.age. Objects are never rewritten, so one copy each is
# complete; each is encrypted to a work file and copied only when the whole pipeline succeeded, so a failed read leaves no partial
# copy behind. Nothing is deleted here: files-purge.sh does that by hand. BACKUP_ALLOW_PLAINTEXT=1 copies without encryption to files/.
# BACKUP_DRY_RUN=1 prints the commands. A listing of the offsite target that fails stops the run: it is never taken for an empty target.
set -euo pipefail
SCRIPT_NAME=files-mirror
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# One sort order for sort and comm.
export LC_ALL=C

setup_backup_remote
setup_files_remote

if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  if [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = 1 ]; then
    log copy "copying files:$S3_BUCKET to backup:$BACKUP_BUCKET/files WITHOUT encryption (BACKUP_ALLOW_PLAINTEXT=1; nothing is ever deleted)"
    run rclone copy "files:$S3_BUCKET" "backup:$BACKUP_BUCKET/files" --transfers 4 --checkers 8 --stats-one-line
    log done "files mirror complete (unencrypted)"
    exit 0
  fi
  die "BACKUP_AGE_RECIPIENT is not set: refusing to copy the files unencrypted (set BACKUP_ALLOW_PLAINTEXT=1 to override)"
fi

target="backup:$BACKUP_BUCKET/files-age"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The listings only read, so they run in a dry run too (its plan needs them). A listing of the source that fails stops the run through
# pipefail. A listing of the target that fails is not an empty target: treating it as one would encrypt and copy every object again,
# and hide an outage or a refused key behind a long run. Only rclone's exit code 3 ("directory not found": the first run, before the
# folder exists) means empty; any other failure stops the run before anything is copied.
rclone lsf -R --files-only "files:$S3_BUCKET" | sort > "$work/source"
listing=0
rclone lsf -R --files-only "$target/" > "$work/listing" 2> "$work/listing.err" || listing=$?
if [ "$listing" -ne 0 ] && [ "$listing" -ne 3 ]; then
  head -n 5 "$work/listing.err" >&2
  die "listing $target failed (rclone exit code $listing): the offsite copy is not treated as empty, and nothing was copied"
fi
[ "$listing" -eq 0 ] || : > "$work/listing"
sed 's/\.age$//' "$work/listing" | sort > "$work/copied"
comm -23 "$work/source" "$work/copied" > "$work/missing"
count=$(wc -l < "$work/missing" | tr -d ' ')
log plan "$count object(s) to encrypt and copy"

copied=0
while IFS= read -r key <&3; do
  [ -n "$key" ] || continue
  run rclone cat "files:$S3_BUCKET/$key" \
    | run age -r "$BACKUP_AGE_RECIPIENT" > "$work/object.age" || die "reading or encrypting $key failed: nothing of it was copied"
  run rclone copyto "$work/object.age" "$target/$key.age"
  rm -f "$work/object.age"
  copied=$((copied + 1))
done 3< "$work/missing"

log done "files mirror complete: $copied copied"
