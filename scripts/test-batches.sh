#!/usr/bin/env bash
# Runs the whole test suite (or the folders given as arguments) as a series of `bun test` processes, one batch of files each,
# and adds up the results.
#
# Why: one process for the whole suite keeps every Nest app it booted until it ends; a single run grew past 11 GB and the
# out-of-memory killer stopped the machine. A fresh process per batch gives the memory back after each batch. The output keeps
# bun's own summary lines (` N pass`, ` N skip`, ` N fail`) for the totals, so logs read the same as before.
set -uo pipefail
cd "$(dirname "$0")/.."
batch=${GSM_TEST_BATCH:-12}
roots=("$@")
[ ${#roots[@]} -eq 0 ] && roots=(./src ./test)
mapfile -t files < <(find "${roots[@]}" -type f \( -name '*.test.ts' -o -name '*.spec.ts' \) -not -path '*/node_modules/*' | sort)
pass=0 skip=0 fail=0 status=0 failed_batches=()
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for ((i = 0; i < ${#files[@]}; i += batch)); do
  part=("${files[@]:i:batch}")
  echo "== batch $((i / batch + 1)): ${#part[@]} files, from ${part[0]}"
  GSM_TEST_BATCHED=1 bun test --timeout 15000 "${part[@]}" 2>&1 | tee "$tmp"
  code=${PIPESTATUS[0]}
  read -r p < <(grep -E '^ *[0-9]+ pass$' "$tmp" | tail -1 | awk '{print $1}')
  read -r s < <(grep -E '^ *[0-9]+ skip$' "$tmp" | tail -1 | awk '{print $1}')
  read -r f < <(grep -E '^ *[0-9]+ fail$' "$tmp" | tail -1 | awk '{print $1}')
  pass=$((pass + ${p:-0})) skip=$((skip + ${s:-0})) fail=$((fail + ${f:-0}))
  if [ "$code" -ne 0 ]; then
    status=1
    failed_batches+=("$((i / batch + 1))")
  fi
done
echo
echo "All ${#files[@]} test files in batches of $batch:"
echo " $pass pass"
echo " $skip skip"
echo " $fail fail"
[ "$status" -ne 0 ] && echo "failed batches: ${failed_batches[*]}"
exit "$status"
