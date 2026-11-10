#!/usr/bin/env bash
# Restores one backup object into an EXPLICIT target database (feature 24D, decision 036).
# Usage: pg-restore.sh <object> <target database url> [--identity <age private key file>] [--force]
#   <object>  path inside the backup bucket, e.g. db/daily/gsm-20261110T011500Z.dump.age
# The target is never defaulted to DATABASE_URL, and a target that already has tables is refused unless --force is given.
# Needs BACKUP_S3_*; an .age object needs --identity. BACKUP_DRY_RUN=1 prints every command instead of running it.
set -euo pipefail
SCRIPT_NAME=pg-restore
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  die "usage: pg-restore.sh <object> <target database url> [--identity <age key file>] [--force]"
}

[ $# -ge 2 ] || usage
object=$1
target=$2
shift 2
identity=""
force=0
while [ $# -gt 0 ]; do
  case $1 in
    --identity)
      [ $# -ge 2 ] || usage
      identity=$2
      shift 2
      ;;
    --force)
      force=1
      shift
      ;;
    *) usage ;;
  esac
done

[[ $target == postgres://* || $target == postgresql://* ]] || die "the target must be a postgres:// URL"
setup_backup_remote

if [[ $object == *.age ]]; then
  [ -n "$identity" ] || die "$object is encrypted: pass --identity <age private key file>"
  dry_run || [ -r "$identity" ] || die "cannot read the identity file $identity"
fi

if dry_run; then
  log guard "dry run: skipping the check that the target database is empty"
else
  tables=$(psql "$target" --no-psqlrc --tuples-only --no-align --command \
    "select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')")
  if [ "${tables:-0}" -gt 0 ] && [ "$force" != 1 ]; then
    die "the target database already has $tables tables: refusing to restore over it (use --force to override)"
  fi
fi

log restore "restoring $object"
if [[ $object == *.age ]]; then
  run rclone cat "backup:$BACKUP_BUCKET/$object" \
    | run age --decrypt -i "$identity" \
    | run pg_restore --clean --if-exists --no-owner --exit-on-error --dbname "$target"
else
  run rclone cat "backup:$BACKUP_BUCKET/$object" \
    | run pg_restore --clean --if-exists --no-owner --exit-on-error --dbname "$target"
fi
log done "restore of $object complete"
