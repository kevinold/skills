#!/usr/bin/env bash
# usage: clean-panes.sh
#   Crash-recovery cleanup for panes a mid-campaign crash left behind — invoked at
#   --resume and close-out, NOT the happy path (where close-lane.sh closes each pane).
#   Closes panes whose agent is done|idle AND whose recent lines show a lane prompt,
#   REUSING lib.sh's shared unsent-input check (gotcha 9). Skips unsent input and
#   non-lane panes, and lists what it skipped. Refuses from a worker/roster context (R24).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

refuse_worker_context "clean-panes.sh"
require_cmd herdr jq

# A lane pane is a roster worker (w<N>) whose transcript shows lane-loop activity.
# ponytail: heuristic; tune the markers if the worker prompt (U5) changes. Anything
# that doesn't match is left alone.
looks_like_lane_pane() {
  local name="$1" recent
  printf '%s' "$name" | grep -Eq '^w[0-9]+$' || return 1
  recent="$(herdr agent read "$name" --source recent --lines 40 2>/dev/null)" || return 1
  printf '%s' "$recent" | grep -Eq '/lfg|/ce-worktree|ce-babysit-pr|Closes #|state:' || return 1
  return 0
}

agents_json="$(herdr agent list 2>/dev/null || echo '{}')"

closed=()
skipped=()
while IFS=$'\t' read -r name status; do
  [ -n "$name" ] || continue
  case "$status" in
    done|idle) ;;
    *) skipped+=("$name: status=$status (not done/idle)"); continue ;;
  esac
  if ! looks_like_lane_pane "$name"; then
    skipped+=("$name: not a lane pane (no w<N> / lane prompt) — left alone"); continue
  fi
  if ! check_no_unsent_input "$name"; then
    skipped+=("$name: unsent operator input — left alone (gotcha 9)"); continue
  fi
  # Close by resolved pane id and trust the honest return: a pane
  # that survives lands in `skipped`, not a falsely-reported `closed`.
  if close_pane_by_agent "$name" >/dev/null; then
    closed+=("$name")
  else
    skipped+=("$name: pane close did not clear it — still listed (close by hand)")
  fi
done < <(printf '%s\n' "$agents_json" | jq -r '.result.agents[]? | [.name, .agent_status] | @tsv')

echo "clean-panes: closed ${#closed[@]} pane(s): ${closed[*]:-none}"
echo "clean-panes: skipped ${#skipped[@]}:"
if [ "${#skipped[@]}" -gt 0 ]; then
  for s in "${skipped[@]}"; do echo "  - $s"; done
fi
