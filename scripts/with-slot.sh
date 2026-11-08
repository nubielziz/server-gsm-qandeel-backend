#!/usr/bin/env bash
# Runs one memory-heavy command (the full test suite, the typed lint) once a machine-wide slot is free.
#
# Why: several worktrees of this repository run their checks on one machine at the same time; a full test run or the typed
# lint each take several GB, and too many at once made the out-of-memory killer stop the whole machine. At most
# GSM_HEAVY_SLOTS (default 2) such commands run at once; the others wait. One lock file per slot in the temp directory, held
# for the command's lifetime (the command inherits the locked descriptor, so the slot frees when it ends, even on a crash).
set -uo pipefail
slots=${GSM_HEAVY_SLOTS:-2}
dir=${TMPDIR:-/tmp}
announced=0
while true; do
  for i in $(seq 1 "$slots"); do
    exec 9>"$dir/gsm-heavy-slot-$i.lock"
    if flock -n 9; then
      "$@"
      exit $?
    fi
    exec 9>&-
  done
  if [ "$announced" -eq 0 ]; then
    echo "Waiting for a free slot (at most $slots heavy runs at once on this machine): $*" >&2
    announced=1
  fi
  sleep 5
done
