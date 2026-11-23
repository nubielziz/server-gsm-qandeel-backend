#!/usr/bin/env bash
# Runs the whole test suite (or the folders given as arguments) as a series of `bun test` processes, one batch of files each,
# and adds up the results.
#
# Why: one process for the whole suite keeps every Nest app it booted until it ends; a single run grew past 11 GB and the
# out-of-memory killer stopped the machine. A fresh process per batch gives the memory back after each batch. The output keeps
# bun's own summary lines (` N pass`, ` N skip`, ` N fail`) for the totals, so logs read the same as before.
#
# Two optional settings, both for a CI that spreads the suite over several machines (decision 057):
#   GSM_TEST_SHARD=k/n  run only the batches whose place in the run, counted from 0, leaves k when divided by n (0 <= k < n).
#                       A batch keeps the number it has in a whole run, and the files are sorted byte by byte, so "batch 17"
#                       names the same files on every machine.
#   GSM_TEST_RERUN=1    run a batch that failed once more on its own, after the others. It counts as failed only when it fails
#                       again: a loaded machine fails a timing-sensitive test now and then, a real failure fails twice.
set -uo pipefail
cd "$(dirname "$0")/.."
batch=${GSM_TEST_BATCH:-12}
shard_k=0 shard_n=1
if [ -n "${GSM_TEST_SHARD:-}" ]; then
  if [[ ! "$GSM_TEST_SHARD" =~ ^([0-9]+)/([1-9][0-9]*)$ ]] || [ "${BASH_REMATCH[1]}" -ge "${BASH_REMATCH[2]}" ]; then
    echo "GSM_TEST_SHARD must be k/n with 0 <= k < n (for example 0/4), not '$GSM_TEST_SHARD'." >&2
    exit 2
  fi
  shard_k=${BASH_REMATCH[1]} shard_n=${BASH_REMATCH[2]}
fi
roots=("$@")
# Every test lives under test/ (decision 043); test/tooling/test-layout.test.ts fails when one is put under src/.
[ ${#roots[@]} -eq 0 ] && roots=(./test)
mapfile -t files < <(find "${roots[@]}" -type f \( -name '*.test.ts' -o -name '*.test.mjs' -o -name '*.spec.ts' \) -not -path '*/node_modules/*' | LC_ALL=C sort)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
declare -A passed skipped failed
ran=() failed_batches=() recovered=()
ran_files=0

# Runs the batch with the given number (counted from 1, as the output names it), keeps its counts and returns bun's exit code.
run_batch() {
  local number=$1
  local part=("${files[@]:(number - 1) * batch:batch}")
  local code p s f
  echo "== batch $number: ${#part[@]} files, from ${part[0]}"
  GSM_TEST_BATCHED=1 bun test --timeout 15000 "${part[@]}" 2>&1 | tee "$tmp"
  code=${PIPESTATUS[0]}
  read -r p < <(grep -E '^ *[0-9]+ pass$' "$tmp" | tail -1 | awk '{print $1}')
  read -r s < <(grep -E '^ *[0-9]+ skip$' "$tmp" | tail -1 | awk '{print $1}')
  read -r f < <(grep -E '^ *[0-9]+ fail$' "$tmp" | tail -1 | awk '{print $1}')
  passed[$number]=${p:-0} skipped[$number]=${s:-0} failed[$number]=${f:-0}
  return "$code"
}

total=$(((${#files[@]} + batch - 1) / batch))
for ((number = 1; number <= total; number++)); do
  [ $(((number - 1) % shard_n)) -eq "$shard_k" ] || continue
  ran+=("$number")
  remaining=$((${#files[@]} - (number - 1) * batch))
  ran_files=$((ran_files + (remaining < batch ? remaining : batch)))
  run_batch "$number" || failed_batches+=("$number")
done

if [ "${GSM_TEST_RERUN:-}" = "1" ] && [ ${#failed_batches[@]} -gt 0 ]; then
  still=()
  for number in "${failed_batches[@]}"; do
    echo
    echo "== batch $number failed: running it once more on its own"
    if run_batch "$number"; then recovered+=("$number"); else still+=("$number"); fi
  done
  failed_batches=(${still[@]+"${still[@]}"})
fi

pass=0 skip=0 fail=0
for number in ${ran[@]+"${ran[@]}"}; do
  pass=$((pass + passed[$number])) skip=$((skip + skipped[$number])) fail=$((fail + failed[$number]))
done
echo
if [ "$shard_n" -gt 1 ]; then
  echo "Shard $shard_k of $shard_n: $ran_files of ${#files[@]} test files in batches of $batch:"
else
  echo "All ${#files[@]} test files in batches of $batch:"
fi
echo " $pass pass"
echo " $skip skip"
echo " $fail fail"
if [ ${#recovered[@]} -gt 0 ]; then
  echo "failed, then passed on a second run: ${recovered[*]}"
  # On GitHub the run stays green, so say it where people look.
  [ "${GITHUB_ACTIONS:-}" = "true" ] && echo "::warning::test batches ${recovered[*]} failed once and passed on a second run"
fi
if [ ${#failed_batches[@]} -gt 0 ]; then
  echo "failed batches: ${failed_batches[*]}"
  exit 1
fi
exit 0
