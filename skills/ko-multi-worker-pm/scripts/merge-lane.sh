#!/usr/bin/env bash
# usage: merge-lane.sh <pr> <kind> [--sub-issue N] [--authors csv] [--primary <path>]
#   Merge a spine lane PR under PM-session-scoped authorization ONLY (R24, KTD3).
#   REFUSES from a worker/roster context via lib.sh's refuse_worker_context — a
#   worker must never invoke this. Runs the pre-merge checklist first (R22 identity
#   + R10 + R23) and refuses on any violation, so only a verified PR can merge.
#   Prints the exact `gh pr merge` command FIRST, then runs it ONLY when the literal
#   SPINE_AUTO_MERGE=yes is set — an accidental-invocation guard, NOT an auth secret;
#   the real control is the operator's allow rule in a PM-scoped setting workers
#   never inherit. Without SPINE_AUTO_MERGE the command is printed and the script
#   exits 0 so the PM posts "ready to merge".
#     preview → --merge (merge commit);  chore → --rebase.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

# R24: refuse in a worker/roster context BEFORE any gh work.
refuse_worker_context "merge-lane.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
require_cmd gh jq node
PRIMARY="$(primary_path_opt "$@")"

PR=""
KIND=""
SUB=""
AUTHORS="${SPINE_AUTHORS:-}"
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    --sub-issue) SUB="${2:-}"; shift 2 ;;
    --sub-issue=*) SUB="${1#--sub-issue=}"; shift ;;
    --authors) AUTHORS="${2:-}"; shift 2 ;;
    --authors=*) AUTHORS="${1#--authors=}"; shift ;;
    -*) shift ;;
    *)
      case "$pos" in
        0) PR="$1" ;;
        1) KIND="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$PR" ] && [ -n "$KIND" ] || die 2 "usage: merge-lane.sh <pr> <kind> [--sub-issue N] [--authors csv] [--primary <path>]"
case "$PR" in ''|*[!0-9]*) die 2 "pr must be numeric (got '$PR')" ;; esac

case "$KIND" in
  preview) MERGE_FLAG="--merge" ;;
  chore) MERGE_FLAG="--rebase" ;;
  *) die 2 "kind must be 'preview' or 'chore' (got '$KIND')" ;;
esac

# gh_ comes from lib.sh (runs gh in the primary checkout when --primary is set).

# The lane sub-issue is where the checklist reads the lane YAML; derive it from
# the PR's `Closes #N` when not supplied (the checklist also asserts it is there).
if [ -z "$SUB" ]; then
  SUB="$(gh_ pr view "$PR" --json body -q .body | grep -oiE 'clos(e|es|ed) +#[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
fi
[ -n "$SUB" ] || die 2 "cannot determine lane sub-issue for PR #$PR (pass --sub-issue N; the PR body needs 'Closes #N')"

# R22/R10/R23: only a verified PR may merge.
checklist_args=()
[ -n "$PRIMARY" ] && checklist_args+=(--primary "$PRIMARY")
[ -n "$AUTHORS" ] && checklist_args+=(--authors "$AUTHORS")
if ! bash "$HERE/pre-merge-checklist.sh" "$PR" "$SUB" ${checklist_args[@]+"${checklist_args[@]}"}; then
  echo "error: refusing to merge PR #$PR — pre-merge checklist failed (not R22/R10/R23 verified)." >&2
  exit 2
fi

MERGE_CMD="gh pr merge $PR $MERGE_FLAG"
echo "merge command: $MERGE_CMD"

if [ "${SPINE_AUTO_MERGE:-}" = "yes" ]; then
  echo "SPINE_AUTO_MERGE=yes — running the merge under PM-scoped authorization (R24)." >&2
  gh_ pr merge "$PR" "$MERGE_FLAG"
  echo "merged PR #$PR ($KIND)"
else
  echo "SPINE_AUTO_MERGE is not set — printed only, not executed (KTD3)." >&2
  echo "ready to merge: PR #$PR ($KIND) — the PM posts 'ready to merge' and the operator merges." >&2
  exit 0
fi
