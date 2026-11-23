#!/usr/bin/env bash
# What the offsite bucket holds now (decision 059), for the host's check and status (deploy/backup/gsm-backup.sh). Read-only: it lists
# and never writes. Prints key=value lines on standard output and nothing else there (the log lines go to standard error):
#   daily_count daily_newest daily_newest_bytes        db/daily/
#   monthly_count monthly_newest monthly_newest_bytes  db/monthly/
#   config_count config_newest config_newest_bytes     config/
#   files_count                                        files-age/ (recursive)
# "Newest" is by name: the names carry a UTC stamp, so the name order is the age order. A prefix that does not exist yet counts as
# empty (rclone exit code 3); any other listing failure fails the script, the same rule as files-mirror.sh: an unreadable bucket is never
# taken for an empty one. Needs BACKUP_S3_*.
set -euo pipefail
SCRIPT_NAME=offsite-status
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# One sort order for the names.
export LC_ALL=C

setup_backup_remote
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Lists one prefix into $work/listing ("size;name" lines, or bare names with -R): empty when the prefix does not exist, a stop otherwise.
list() { # <prefix> [rclone lsf options]...
  local prefix=$1 code=0
  shift
  rclone lsf --files-only "$@" "backup:$BACKUP_BUCKET/$prefix/" > "$work/listing" 2> "$work/listing.err" || code=$?
  if [ "$code" -eq 3 ]; then
    log list "$prefix/ does not exist yet: counted as empty" >&2
    : > "$work/listing"
  elif [ "$code" -ne 0 ]; then
    head -n 5 "$work/listing.err" >&2
    die "listing backup:$BACKUP_BUCKET/$prefix failed (rclone exit code $code): the offsite copy is not taken for an empty one"
  fi
}

# Prints the count, the newest name and its size of one prefix: <key>_count, <key>_newest, <key>_newest_bytes.
summary() { # <key> <prefix>
  local key=$1 count newest="" bytes="" line
  list "$2" --format sp --separator ';'
  count=$(grep -c . "$work/listing" || true)
  if [ "$count" -gt 0 ]; then
    line=$(sort -t ';' -k 2 "$work/listing" | tail -n 1)
    bytes=${line%%;*}
    newest=${line#*;}
  fi
  printf '%s_count=%s\n%s_newest=%s\n%s_newest_bytes=%s\n' "$key" "$count" "$key" "$newest" "$key" "$bytes"
}

summary daily db/daily
summary monthly db/monthly
summary config config
list files-age -R
printf 'files_count=%s\n' "$(grep -c . "$work/listing" || true)"
log done "offsite status of backup:$BACKUP_BUCKET listed" >&2
