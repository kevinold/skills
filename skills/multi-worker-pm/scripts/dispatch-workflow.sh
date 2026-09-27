#!/usr/bin/env bash
# usage: dispatch-workflow.sh <workflow.yml> <sha> [-f key=value ...] [--primary <path>]
#   Dispatch <workflow.yml> on the base branch (config baseBranch) and print the UNIQUE new run id (gotcha 5 —
#   `gh workflow run` returns no id). Captures T and ME BEFORE the dispatch, then
#   polls `gh run list` (scoped to $ME, createdAt >= T, headSha == <sha>) through
#   `run.mjs spine select-run` — the selection rule lives there (KTD6/R13), never
#   here. Prints `RUN_ID=<id>` on success. Exit 2 on ambiguous (operator inspects
#   and passes --run-id to disambiguate); exit 3 when no matching run appears.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
require_cmd gh jq node
PRIMARY="$(primary_path_opt "$@")"

WF=""
SHA=""
FWD=()
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    -f) FWD+=(-f "${2:-}"); shift 2 ;;
    *)
      case "$pos" in
        0) WF="$1" ;;
        1) SHA="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$WF" ] && [ -n "$SHA" ] || die 2 "usage: dispatch-workflow.sh <workflow.yml> <sha> [-f key=value ...] [--primary <path>]"

# The inner `run.mjs` call must load the SAME config this script resolved (R3/R5) —
# without --primary it falls back to the git common-dir of the caller's cwd.
set_primary_args
BASE="$(pm_cfg '.baseBranch' ${primary_args[@]+"${primary_args[@]}"})" || exit $?

# gh_ (run gh in the primary checkout when --primary is set) comes from lib.sh.
# git_ mirrors it for the ancestry check below; no lib.sh helper exists, so it is
# defined here beside its only use.
git_() { if [ -n "${PRIMARY:-}" ]; then ( cd "$PRIMARY" && git "$@" ); else git "$@"; fi; }

# Annotate each candidate run with isDescendant: true when $SHA — the merge
# sha the bar was dispatched FOR — is an ancestor of the run's headSha. A
# workflow_dispatch run is stamped with the branch TIP, not $SHA, so once another
# commit lands on the base the lane's own run has headSha != $SHA and is a descendant
# of it. selectUniqueRun reads this precomputed boolean and stays pure. A check that cannot run
# (commit not local) reads as not-descendant: fail closed — an exact-$SHA run still
# matches on equality, and nothing unrelated is ever adopted.
annotate_ancestry() {
  local runs="$1" desc="" h
  while IFS= read -r h; do
    [ -n "$h" ] || continue
    git_ merge-base --is-ancestor "$SHA" "$h" 2>/dev/null && desc="$desc $h" || true
  done < <(printf '%s' "$runs" | jq -r '.[].headSha' | sort -u)
  printf '%s' "$runs" | jq --arg desc "$desc" '
    ($desc | split(" ") | map(select(length > 0))) as $d
    | map(.headSha as $h | .isDescendant = (($d | index($h)) != null))'
}

# Capture the window BEFORE dispatch so the run we start is the only same-actor
# candidate at-or-after T (KTD6). ME scopes the poll to our own dispatches.
T="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ME="$(gh_ api user -q .login)"

gh_ workflow run "$WF" --ref "$BASE" ${FWD[@]+"${FWD[@]}"}
echo "dispatched $WF at $T by $ME (sha $SHA)" >&2

for _ in 1 2 3 4 5 6; do
  sleep 15
  RUNS="$(gh_ run list --workflow "$WF" --branch "$BASE" --event workflow_dispatch --user "$ME" \
            --json databaseId,createdAt,headSha 2>/dev/null || echo '[]')"
  # Refresh BEFORE annotating, every poll: the run's headSha is the base's
  # tip, which the primary may not hold locally yet, and merge-base fails closed on
  # an unknown commit — so a run that appears mid-poll would stay isDescendant:false
  # forever with a one-time fetch. Best-effort — a failed fetch leaves ancestry to
  # whatever is already local (still fail closed, never mis-adopt).
  git_ fetch --quiet origin "$BASE" 2>/dev/null || true
  RUNS="$(annotate_ancestry "$RUNS")"
  # select-run: prints the id + exit 0; exit 2 ambiguous (with the --run-id hint
  # on stderr); exit 3 none-yet. Keep polling only on 3.
  # NOTE: `gh run list --json` does not carry an actor field, and `--user "$ME"`
  # already scopes the poll server-side, so do NOT pass --actor here — a
  # client-side actor filter against actor-less rows would drop every run (KTD6).
  if OUT="$(node "$HERE/run.mjs" spine select-run ${primary_args[@]+"${primary_args[@]}"} --runs "$RUNS" --since "$T" --sha "$SHA")"; then
    echo "RUN_ID=$OUT"
    exit 0
  else
    code=$?
    [ "$code" = "2" ] && exit 2
  fi
done
die 3 "no matching run for $WF at sha $SHA within ~90s (retry, or pass --run-id after inspecting 'gh run list')"
