#!/usr/bin/env bash
# Monthly restore drill (feature 24D, decisions 036 and 055): restores the newest daily dump as a temporary role that is not a
# superuser, into a scratch database that role owns, on the same server; checks that the ledger sums to zero and that the migrations
# match, prints row counts and drops the scratch database and the role. A dump's statements then run with the rights of that role,
# never the owner's.
# Usage: restore-drill.sh --identity <age private key file>      (needs DATABASE_URL of a role that can create databases and roles)
# Optional: MIGRATIONS_DIR (default /drizzle, the repository's drizzle/ folder mounted read-only) for the migration check.
# Exit code is non-zero on any mismatch. BACKUP_DRY_RUN=1 prints every command instead of running it.
set -euo pipefail
SCRIPT_NAME=restore-drill
here=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=lib.sh
. "$here/lib.sh"

identity=""
while [ $# -gt 0 ]; do
  case $1 in
    --identity)
      [ $# -ge 2 ] || die "usage: restore-drill.sh --identity <age key file>"
      identity=$2
      shift 2
      ;;
    *) die "usage: restore-drill.sh --identity <age key file>" ;;
  esac
done

require_vars DATABASE_URL
setup_backup_remote
migrations_dir=${MIGRATIONS_DIR:-/drizzle}

stamp=$(utc_stamp)
scratch="gsm_restore_drill_$(printf '%s' "$stamp" | tr 'A-Z' 'a-z')"
# The scratch role's password: 48 hex characters, never printed (it travels on a pipe, and the URLs that hold it are redacted).
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
base=${DATABASE_URL%%\?*}
query=""
[[ $DATABASE_URL == *\?* ]] && query="?${DATABASE_URL#*\?}"
rest=${base#*://}
hostpart=${rest#*@}
hostport=${hostpart%%/*}
scratch_url="postgres://$scratch:$password@$hostport/$scratch$query"

# Sends one statement to psql on its standard input, so a password in it is never an argument (a dry run and `ps` do not show it).
psql_stdin() {
  if dry_run; then
    run psql "$DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1
  else
    printf '%s\n' "$1" | psql "$DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1
  fi
}

daily="backup:$BACKUP_BUCKET/db/daily"
if dry_run; then
  newest="gsm-<newest>.dump.age"
  log pick "dry run: the newest object of $daily would be restored"
else
  newest=$(rclone lsf --files-only "$daily/" | sort | tail -n 1)
  [ -n "$newest" ] || die "no daily backup found in $daily"
  log pick "restoring the newest daily dump: $newest"
fi

cleanup() {
  log cleanup "dropping the scratch database $scratch and its role"
  run psql "$DATABASE_URL" --no-psqlrc --command "drop database if exists $scratch with (force)" || true
  run psql "$DATABASE_URL" --no-psqlrc --command "drop role if exists $scratch" || true
}
trap cleanup EXIT

psql_stdin "create role $scratch login password '$password' nosuperuser nocreatedb nocreaterole;"
run psql "$DATABASE_URL" --no-psqlrc --command "create database $scratch owner $scratch"
restore_args=("db/daily/$newest" "$scratch_url")
[ -z "$identity" ] || restore_args+=(--identity "$identity")
run "$here/pg-restore.sh" "${restore_args[@]}"

if dry_run; then
  log checks "dry run: ledger sum, migration count and row counts would be checked on $scratch"
  exit 0
fi

query_one() {
  psql "$scratch_url" --no-psqlrc --tuples-only --no-align --command "$1"
}

# Every ledger line is signed and each transaction adds up to zero, so the whole table must add up to zero (decision 024).
[ "$(query_one 'select coalesce(sum(amount), 0) = 0 from ledger_entries')" = t ] || die "the ledger entries of the restored dump do not sum to zero"
log check "ledger_entries sum to zero"

restored=$(query_one 'select count(*) from drizzle.__drizzle_migrations')
files=$(find "$migrations_dir" -maxdepth 1 -name '*.sql' | wc -l)
if [ "$files" -eq 0 ]; then
  die "no migration files found in $migrations_dir (mount the repository's drizzle/ folder there)"
fi
if [ "$restored" -gt "$files" ]; then
  die "the dump has $restored migrations but this code has only $files: the dump is from a newer version"
elif [ "$restored" -lt "$files" ]; then
  # A deploy since last night's dump added a migration: not a failure, but worth seeing.
  log warn "the dump has $restored migrations, the code has $files (a migration was applied after the dump)"
else
  log check "migrations match: $restored"
fi

for table in orders clients ledger_transactions; do
  log count "$table: $(query_one "select count(*) from $table")"
done
log done "restore drill passed with $newest"
