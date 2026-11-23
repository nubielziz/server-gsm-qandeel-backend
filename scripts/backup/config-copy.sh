#!/usr/bin/env bash
# Offsite copy of the server's own configuration (decision 059): the host packs its settings files, encrypts them for
# BACKUP_AGE_RECIPIENT with age ON THE HOST and pipes the result to this script, which stores it as config/<name>. The container never
# sees the plaintext (decision 055 keeps .env.production away from it), and this script refuses any input that is not an age file, so a
# plaintext configuration can never reach the bucket: there is no BACKUP_ALLOW_PLAINTEXT here. The input is read into a work file first
# and copied only when it is complete; the object is then checked in the bucket (it must exist and not be empty), as pg-backup.sh does.
# Usage: config-copy.sh gsm-config-<YYYYMMDDTHHMMSSZ>.tar.gz.age < encrypted-file
# Needs BACKUP_S3_*. BACKUP_DRY_RUN=1 reads and checks the input, then prints the copy instead of running it.
set -euo pipefail
SCRIPT_NAME=config-copy
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -eq 1 ] || die "usage: config-copy.sh gsm-config-<YYYYMMDDTHHMMSSZ>.tar.gz.age < encrypted-file"
name=$1
[[ $name =~ ^gsm-config-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.age$ ]] \
  || die "the object name must be gsm-config-<YYYYMMDDTHHMMSSZ>.tar.gz.age: nothing was uploaded"
setup_backup_remote
target="backup:$BACKUP_BUCKET/config"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/$name"

# An age file begins with its version line. Anything else (a tar file, an empty input, an armored file) is refused before any copy.
first=""
if ! IFS= read -r first < "$work/$name" || [ "$first" != "age-encryption.org/v1" ]; then
  die "the input is not an age-encrypted file (it does not begin with the line age-encryption.org/v1): nothing was uploaded"
fi

log upload "copying $name to the configuration copies"
run rclone copyto "$work/$name" "$target/$name"

# The object must exist and not be empty, or the run fails (a silent empty upload is the classic backup failure).
if dry_run; then
  log verify "dry run: skipping the size check of $name"
else
  size=$(rclone lsf --files-only --format sp --separator ';' "$target/" | awk -F';' -v n="$name" '$2 == n { print $1 }')
  [[ ${size:-0} =~ ^[0-9]+$ && ${size:-0} -gt 0 ]] || die "uploaded object $name is missing or empty"
  log verify "$name uploaded, $size bytes"
fi

log done "configuration copy $name complete"
