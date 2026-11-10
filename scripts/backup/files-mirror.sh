#!/usr/bin/env bash
# Mirror of the files bucket (feature 24D, decision 036): `rclone copy` from the application's bucket (S3_*) to the offsite
# bucket (BACKUP_S3_*). Copy, never sync: an object deleted at the source must not disappear from the backup.
# Objects have unique keys and are never rewritten, so one copy of each is complete. BACKUP_DRY_RUN=1 prints the command.
set -euo pipefail
SCRIPT_NAME=files-mirror
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

setup_backup_remote
setup_files_remote

log copy "copying files:$S3_BUCKET to backup:$BACKUP_BUCKET/files (nothing is ever deleted)"
run rclone copy "files:$S3_BUCKET" "backup:$BACKUP_BUCKET/files" --transfers 4 --checkers 8 --stats-one-line
log done "files mirror complete"
