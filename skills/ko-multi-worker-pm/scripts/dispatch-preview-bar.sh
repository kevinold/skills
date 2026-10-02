#!/usr/bin/env bash
# usage: dispatch-preview-bar.sh <bar-plan.json> [--primary <path>]
#   Run the DISPATCH-mode post-merge bar described by a `run.mjs spine bar` plan
#   (KTD4). The workflow, the `-f` inputs, the run count and the retry marker all
#   come from that plan — this script names none of them, so it is the same bar in
#   any repo. N SERIAL dispatches bound to the plan's mergeSha (per-SHA
#   concurrency — dispatch the next only after the previous completes).
#
#   The run's conclusion is mapped by `spine bar --outcome` (R8), never here:
#     OUTCOME=verified  exit 0   every run success, every job success, no retry markers
#     OUTCOME=regressed exit 1   a run that CONCLUDED red (the caller posts base-regressed)
#     OUTCOME=infra     exit 3   could-not-run (the caller posts blocked-infra, never regressed)
#   A plan carrying `runId` (the operator's `--run-id` re-entry) skips the dispatch
#   and evaluates that already-validated run instead.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
require_cmd gh jq node
PRIMARY="$(primary_path_opt "$@")"

PLAN=""
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    *)
      case "$pos" in
        0) PLAN="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$PLAN" ] || die 2 "usage: dispatch-preview-bar.sh <bar-plan.json> [--primary <path>]"
[ -f "$PLAN" ] || die 2 "bar plan '$PLAN' not found (write \`run.mjs spine bar …\` output to a file first)"

BAR="$(cat "$PLAN")"
MODE="$(printf '%s' "$BAR" | json_get '.mode' 'bar mode')"
[ "$MODE" = "dispatch" ] || die 2 "bar mode '$MODE' is not dispatch — push mode is driven by select-push-run.sh, not this script"

WF="$(printf '%s' "$BAR" | json_get '.workflow' 'bar workflow')"
SHA="$(printf '%s' "$BAR" | json_get '.mergeSha' 'bar mergeSha')"
N="$(printf '%s' "$BAR" | json_get '.runs' 'bar run count')"
MARKER="$(printf '%s' "$BAR" | jq -r '.retryMarker // ""')"
PRESET_RID="$(printf '%s' "$BAR" | jq -r '.runId // ""')"
case "$N" in ''|*[!0-9]*) die 2 "bar runs must be a positive integer (got '$N')" ;; esac
[ "$N" -ge 1 ] || die 2 "bar runs must be >= 1 (got '$N')"

# gh_ comes from lib.sh (runs gh in the primary checkout when --primary is set).

# Forward --primary to every child that reads the config — the per-run dispatch
# wrapper AND watch-run.sh, which resolves the bar timeout through pm_cfg and
# would otherwise read it from THIS script's cwd (empty-array safe under set -u).
set_primary_args

# The workflow inputs, verbatim from the plan (${sha} already substituted).
FARGS=()
while IFS= read -r kv; do
  [ -n "$kv" ] && FARGS+=(-f "$kv")
done < <(printf '%s' "$BAR" | jq -r '.inputs // {} | to_entries[] | "\(.key)=\(.value)"')

# Evaluate one completed run: conclusion → outcome (R8), then the stricter
# job-level and retry-marker checks a green conclusion must also survive.
evaluate_run() {
  local rid="$1" label="$2" view conc outcome concs log retries
  # One fetch for both fields — this runs once per dispatched run, up to the bar's
  # run count. An unreadable run leaves $view empty, so $conc is empty and the
  # conclusion mapping below fails closed to could-not-run exactly as before.
  view="$(gh_ run view "$rid" --json conclusion,jobs 2>/dev/null || echo "")"
  conc="$(printf '%s' "$view" | jq -r '.conclusion // ""' 2>/dev/null || echo "")"
  outcome="$(node "$HERE/run.mjs" spine bar ${primary_args[@]+"${primary_args[@]}"} --outcome "$conc" || true)"
  case "$outcome" in
    verified) ;;
    regressed) echo "OUTCOME=regressed"; die 1 "run $rid ($label): concluded '$conc' — the base branch is red" ;;
    infra) echo "OUTCOME=infra"; die 3 "run $rid ($label): concluded '${conc:-none}' — the bar could not run (blocked-infra, NOT a regression)" ;;
    *) echo "OUTCOME=infra"; die 3 "run $rid ($label): could not map conclusion '$conc' — failing closed as could-not-run" ;;
  esac

  # Every job must conclude success or skipped. A SKIPPED job is not a
  # failure: a conditionally-inert job (one gated on a repo var, so it is skipped
  # until explicitly armed) skips on every default run, and a workflow that has
  # one treats its skipped lane as ok. Counting it red false-regressed every preview
  # lane — and `base-regressed` halts the WHOLE queue, not just the lane. A
  # genuine failure still trips this as failure/cancelled/timed_out, including a
  # job skipped BECAUSE an upstream one failed (that upstream job reads `failure`).
  concs="$(printf '%s' "$view" | jq -r '.jobs[].conclusion')"
  if printf '%s\n' "$concs" | grep -vqxE 'success|skipped'; then
    echo "OUTCOME=regressed"
    die 1 "run $rid ($label): non-success job conclusion(s): $(printf '%s' "$concs" | tr '\n' ' ')"
  fi

  # …and NO retry markers when the config names one (a retried-then-green run is
  # treated as red). Matched as a FIXED STRING (KTD2) — the config carries a
  # literal, never a regex. Fail CLOSED on a log-fetch failure: an unreadable log
  # must not read as "zero retries" and silently certify a flaky run.
  [ -n "$MARKER" ] || return 0
  log="$(mktemp)"
  if ! gh_ run view "$rid" --log >"$log" 2>/dev/null; then
    rm -f "$log"
    echo "OUTCOME=infra"
    die 3 "run $rid ($label): could not fetch the run log to check retry markers — failing closed (could-not-run)"
  fi
  retries="$(grep -c -F "$MARKER" "$log" || true)"
  rm -f "$log"
  if [ "${retries:-0}" -gt 0 ]; then
    echo "OUTCOME=regressed"
    die 1 "run $rid ($label): $retries retry marker(s) '$MARKER' — flaky, treat as red"
  fi
  echo "run $rid: success, no retry markers" >&2
}

if [ -n "$PRESET_RID" ]; then
  # `spine bar --run-id` already bound this run to the bar's workflow and commit.
  echo "=== evaluating operator-supplied run $PRESET_RID (sha $SHA) ===" >&2
  bash "$HERE/watch-run.sh" "$PRESET_RID" ${primary_args[@]+"${primary_args[@]}"} ||
    { echo "OUTCOME=infra"; die 3 "run $PRESET_RID: still running at the bar timeout (could-not-run)"; }
  evaluate_run "$PRESET_RID" "operator --run-id"
  echo "OUTCOME=verified"
  exit 0
fi

i=1
while [ "$i" -le "$N" ]; do
  echo "=== $WF run $i of $N (sha $SHA) ===" >&2

  RUN_LINE="$(bash "$HERE/dispatch-workflow.sh" "$WF" "$SHA" ${FARGS[@]+"${FARGS[@]}"} ${primary_args[@]+"${primary_args[@]}"})" || {
    code=$?
    echo "OUTCOME=infra"
    die 3 "run $i of $N: dispatch-workflow.sh exited $code — no attributable run (could-not-run, NOT a regression)"
  }
  echo "$RUN_LINE"
  RID="${RUN_LINE##*RUN_ID=}"
  { [ -n "$RID" ] && [ "$RID" != "$RUN_LINE" ]; } || { echo "OUTCOME=infra"; die 3 "run $i of $N: dispatch-workflow.sh did not print RUN_ID"; }

  # Per-SHA concurrency: block on this run before dispatching the next. A watch
  # that hits the configured bar timeout exits 3 — still could-not-run.
  bash "$HERE/watch-run.sh" "$RID" ${primary_args[@]+"${primary_args[@]}"} || { echo "OUTCOME=infra"; die 3 "run $RID ($i of $N): still running at the bar timeout (could-not-run)"; }
  evaluate_run "$RID" "$i of $N"
  i=$((i + 1))
done
echo "OUTCOME=verified"
echo "all $N $WF run(s) green at sha $SHA" >&2
