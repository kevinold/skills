#!/usr/bin/env bash
# usage: watch-run.sh <run-id> [interval] [timeout-minutes] [--primary <path>]
#   Change-only loop over `gh run view --json status,conclusion` (repo inferred from
#   cwd); prints on each status/conclusion change; exits 0 when the run is completed.
#   A run still queued or in progress when the bar timeout expires exits 3 — the
#   could-not-run outcome (R8), never a regression. The limit comes from the
#   config's postMergeBar.timeoutMinutes (KTD4); the third positional overrides it
#   for an operator waiting on a shorter leash (and for the tests).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

require_cmd gh

PRIMARY="$(primary_path_opt "$@")"

# --primary is stripped BEFORE the positionals are read (the sibling scripts' loop),
# so the documented trailing form lands the flag nowhere near the interval/timeout
# slots — passing it as `watch-run.sh <run-id> --primary <path>` used to die 2.
RUN=""
INTERVAL=""
TIMEOUT_MINUTES=""
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    *)
      case "$pos" in
        0) RUN="$1" ;;
        1) INTERVAL="$1" ;;
        2) TIMEOUT_MINUTES="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$RUN" ] || die 2 "usage: watch-run.sh <run-id> [interval] [timeout-minutes] [--primary <path>]"
INTERVAL="${INTERVAL:-120}"

# The loop consumed "$@", so the config read below has to be handed --primary again
# — otherwise it resolves the bar timeout from THIS script's cwd (empty-array safe
# under set -u).
set_primary_args
[ -n "$TIMEOUT_MINUTES" ] || TIMEOUT_MINUTES="$(pm_cfg '.postMergeBar.timeoutMinutes' ${primary_args[@]+"${primary_args[@]}"})"
case "$TIMEOUT_MINUTES" in ''|*[!0-9]*) die 2 "timeout-minutes must be a non-negative integer (got '$TIMEOUT_MINUTES')" ;; esac

DEADLINE=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
prev=""
while true; do
  s="$(gh run view "$RUN" --json status,conclusion --jq '.status + "/" + (.conclusion // "")' 2>/dev/null || echo "probe-error/")"
  if [ "$s" != "$prev" ]; then
    echo "run $RUN: $s $(date -u +%H:%M:%SZ)"
    prev="$s"
  fi
  case "$s" in completed/*) exit 0 ;; esac
  [ "$(date +%s)" -lt "$DEADLINE" ] || die 3 "run $RUN: timeout after ${TIMEOUT_MINUTES}m, still '$s' (could-not-run → blocked-infra)"
  sleep "$INTERVAL"
done
