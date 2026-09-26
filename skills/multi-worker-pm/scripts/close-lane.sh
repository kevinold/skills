#!/usr/bin/env bash
# usage: close-lane.sh <name> <worktree> [--primary <path>]
#   Terminal-path cleanup for a lane (guaranteed on every exit path — R26): close the
#   worker pane, unlock + force-remove its worktree (gotcha 8). REFUSES from a
#   worker/roster context (R24) and refuses when the pane holds unsent operator input
#   (gotcha 9, via lib.sh's shared check).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

refuse_worker_context "close-lane.sh"
PRIMARY="$(primary_path "$@")" || exit 4
require_cmd herdr git jq

NAME=""
WORKTREE=""
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    -*) shift ;;
    *)
      case "$pos" in
        0) NAME="$1" ;;
        1) WORKTREE="$1" ;;
      esac
      pos=$((pos + 1))
      shift ;;
  esac
done
[ -n "$NAME" ] && [ -n "$WORKTREE" ] || die 2 "usage: close-lane.sh <name> <worktree> [--primary <path>]"

# gotcha 9 / R26: never close over an operator's unsent input.
if ! check_no_unsent_input "$NAME"; then
  die 9 "refusing to close '$NAME': unsent operator input in the pane. Clear or send it, then retry."
fi

# Close the pane by its resolved id (best-effort, verified honestly — gotcha 10). `|| true` keeps a survived pane from aborting the terminal path:
# the worktree + credential removal below MUST still run (R26). The helper prints
# an honest "closed"/"still listed" line either way, so a survivor is never hidden.
close_pane_by_agent "$NAME" || true

# Worktree removal — the lock survives a pane close, so unlock then force-remove (gotcha 8).
( cd "$PRIMARY" && git worktree unlock "$WORKTREE" 2>/dev/null || true )
( cd "$PRIMARY" && git worktree remove --force "$WORKTREE" )
echo "worktree removed: $WORKTREE"

exit 0
