#!/usr/bin/env bash
# Purge of the offsite files copy (decision 055): deletes from files-age/ every encrypted copy whose object no longer exists in the
# application's bucket (an attachment past its retention, an anonymized customer's files, a discarded upload). Run by hand with a key that
# may delete in the offsite bucket (BACKUP_PURGE_S3_ACCESS_KEY_ID, BACKUP_PURGE_S3_SECRET_ACCESS_KEY), which never stays on the server.
# With versioning, the old versions go when the lifecycle rule expires noncurrent versions (docs/OPERATIONS.md section 4).
# An empty listing of the application's bucket is refused (it would delete every copy). BACKUP_DRY_RUN=1 lists what would be deleted.
set -euo pipefail
SCRIPT_NAME=files-purge
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# One sort order for sort and comm.
export LC_ALL=C

require_vars BACKUP_PURGE_S3_ACCESS_KEY_ID BACKUP_PURGE_S3_SECRET_ACCESS_KEY
export BACKUP_S3_ACCESS_KEY_ID="$BACKUP_PURGE_S3_ACCESS_KEY_ID" BACKUP_S3_SECRET_ACCESS_KEY="$BACKUP_PURGE_S3_SECRET_ACCESS_KEY"
setup_backup_remote
setup_files_remote

target="backup:$BACKUP_BUCKET/files-age"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rclone lsf -R --files-only "files:$S3_BUCKET" | sort > "$work/source"
rclone lsf -R --files-only "$target/" | sed 's/\.age$//' | sort > "$work/copied"
# A listing that answers nothing is more likely an outage or a wrong bucket than a bucket without files.
if [ ! -s "$work/source" ] && [ -s "$work/copied" ]; then
  die "the listing of files:$S3_BUCKET is empty while copies exist: refusing to delete every copy"
fi
comm -13 "$work/source" "$work/copied" > "$work/gone"
count=$(wc -l < "$work/gone" | tr -d ' ')
log plan "$count copy(ies) of deleted objects to remove"

removed=0
while IFS= read -r key <&3; do
  [ -n "$key" ] || continue
  run rclone deletefile "$target/$key.age"
  removed=$((removed + 1))
done 3< "$work/gone"

log done "purge complete: $removed removed"
