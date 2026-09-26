#!/usr/bin/env bash
# usage: spawn-worker.sh <agent-name> --pane <id> [--primary <path>]
#   Starts a config `workerKind` agent (default claude) in a pane the PM already created (the root pane of the
#   worker's labeled herdr tab — SKILL.md "Tabs, workspaces, labels"). Never splits
#   a pane. Prints `pane=<id>` and a compact start summary. Exits 3 (with the dialog
#   hint) when herdr reports agent_not_ready (gotcha 10), and 4 when the primary is
#   unset or the started agent's cwd is not the primary (R6 / rule 5).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

USAGE="usage: spawn-worker.sh <agent-name> --pane <id> [--primary <path>]"
PRIMARY="$(primary_path "$@")" || exit 4
require_cmd herdr jq node
KIND="$(pm_cfg '.workerKind' --primary "$PRIMARY")" || exit $?

NAME=""
P=""
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    --pane) P="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --pane=*) P="${1#--pane=}"; shift ;;
    -*) shift ;;
    *) NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] && [ -n "$P" ] || die 2 "$USAGE"
echo "pane=$P"

START="$(herdr agent start "$NAME" --kind "$KIND" --pane "$P" --timeout 90000)"
printf '%s' "$START" | jq -c '{error, agent: .result.agent.name, status: .result.agent.agent_status}'

STATUS="$(printf '%s' "$START" | jq -r '.result.agent.agent_status // .error // "unknown"')"
if [ "$STATUS" = "agent_not_ready" ] || printf '%s' "$START" | jq -e '.error == "agent_not_ready"' >/dev/null 2>&1; then
  echo "agent_not_ready: worker hit a startup dialog (usually the trust-folder prompt)." >&2
  echo "  run: herdr agent read $NAME  — answer it, wait for idle, then send the prompt." >&2
  exit 3
fi

# R6: the tab MWPM created must have started the worker in the primary. A roster
# that is not a well-formed array is herdr drift (exit 7), never a pass.
CWD="$(herdr agent list | jq -er --arg n "$NAME" '(.result.agents | if type == "array" then . else error end) | map(select(.name == $n))[0].cwd' 2>/dev/null)" \
  || die 7 "could not read cwd of agent $NAME from herdr agent list (herdr surface drift? run 'herdr --skill | head -40')"
real() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
if [ "$(real "$CWD")" != "$(real "$PRIMARY")" ]; then
  die 4 "agent $NAME started in '$CWD', not the primary '$PRIMARY' — close its pane and re-create the tab with --cwd <primary>"
fi
