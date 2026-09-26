#!/usr/bin/env bash
# usage: select-push-run.sh <workflow.yml> <merge-sha> <merged-at> [--primary <path>]
#   PUSH-mode post-merge bar (R7/KTD4): the run the base-branch push ITSELF
#   triggered at the merge commit — no `workflow_dispatch`, so a consumer repo
#   whose CI has no dispatch trigger still gets a bar. Lists
#   `--event push --branch <baseBranch> --commit <merge-sha>` runs and hands them to
#   `run.mjs spine select-run` with `--since <merged-at − 60s>` and NO actor
#   (GitHub started the run, not us) — the selection rule lives there (KTD6/R13),
#   never here. Prints `RUN_ID=<id>`. Exit 2 on ambiguous (the operator inspects
#   and re-enters with `spine bar --run-id`); exit 3 when no run appears within
#   the same ~90 s window dispatch-workflow.sh uses (could-not-run → blocked-infra).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
require_cmd gh jq node date
PRIMARY="$(primary_path_opt "$@")"

WF=""
SHA=""
MERGED_AT=""
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    *)
      case "$pos" in
        0) WF="$1" ;;
        1) SHA="$1" ;;
        2) MERGED_AT="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$WF" ] && [ -n "$SHA" ] && [ -n "$MERGED_AT" ] ||
  die 2 "usage: select-push-run.sh <workflow.yml> <merge-sha> <merged-at> [--primary <path>]"

# Every inner `run.mjs` call must load the SAME config this script resolved (R3/R5):
# without --primary the inner load falls back to the git common-dir of the caller's
# cwd, so a malformed primary config would not stop this entrypoint and the digest
# line it prints would name the wrong config.
set_primary_args
BASE="$(pm_cfg '.baseBranch' ${primary_args[@]+"${primary_args[@]}"})" || exit $?

# mergedAt − 60s: the push run is created around the merge, and GitHub's
# `mergedAt` can trail the run by a second or two. GNU date first, BSD date
# second; an unparseable timestamp STOPS rather than widening the window to
# "any run", which would let an unrelated push certify the lane.
WHOLE_SECONDS="${MERGED_AT%%.*}"
SINCE="$(date -u -d "$MERGED_AT - 60 seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
  date -u -j -v-60S -f %Y-%m-%dT%H:%M:%SZ "${WHOLE_SECONDS%Z}Z" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
[ -n "$SINCE" ] || die 2 "could not parse --merged-at '$MERGED_AT' into a selection window"
echo "selecting the $BASE push run of $WF at $SHA since $SINCE" >&2

# gh_ (run gh in the primary checkout when --primary is set) comes from lib.sh.
for _ in 1 2 3 4 5 6; do
  sleep 15
  # --commit and --event scope the list server-side; select-run still re-checks
  # headSha and the window client-side, so a surface change cannot widen the rule.
  RUNS="$(gh_ run list --workflow "$WF" --branch "$BASE" --event push --commit "$SHA" \
            --json databaseId,createdAt,headSha 2>/dev/null || echo '[]')"
  # NO --actor: the push run's actor is whoever merged, not the PM (KTD6).
  if OUT="$(node "$HERE/run.mjs" spine select-run ${primary_args[@]+"${primary_args[@]}"} --runs "$RUNS" --since "$SINCE" --sha "$SHA")"; then
    echo "RUN_ID=$OUT"
    exit 0
  else
    code=$?
    [ "$code" = "2" ] && exit 2
  fi
done
die 3 "no push run for $WF at sha $SHA within ~90s (could-not-run → blocked-infra; inspect 'gh run list' and re-enter with spine bar --run-id)"
