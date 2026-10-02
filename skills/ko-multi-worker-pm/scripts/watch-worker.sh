#!/usr/bin/env bash
# usage: watch-worker.sh <agent-name> [interval] [--primary <path>]
#   Change-only loop over `herdr agent list` (agent_status|foreground_cwd). Prints
#   one line per change; prints the env-file copy commands ONCE when foreground_cwd
#   flips to a worktree (gotcha 11); exits on a terminal status.
#   Terminal statuses: done|blocked|idle|exited|error|missing — `error` is kept so a
#   crashed worker ends the watch instead of looping forever (R8).
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

PRIMARY="$(primary_path "$@")" || exit 4
require_cmd herdr jq node

# The primary-only files a worker needs copied into its worktree (R13). An empty
# workerEnvFiles (the default) prints no copy line at all. Loaded at top level so
# the `config:` line prints once.
pm_cfg_load "$@" || exit $?
ENV_FILES="$(printf '%s' "$PM_CFG_JSON" | jq -r '(.workerEnvFiles // [])[]')"

# One copy line per entry, into the worktree $1. A trailing `/` marks a directory
# (copied whole, into its parent); anything else is a file or a glob, left
# unquoted so the shell expands it when the operator pastes the line.
print_env_copy_lines() {
  local wt="$1" e rel parent dest
  [ -n "$ENV_FILES" ] || return 0
  echo "ENV FILES: copy into the new worktree (run from the primary $PRIMARY):"
  while IFS= read -r e; do
    [ -n "$e" ] || continue
    rel="${e%/}"
    parent="$(dirname "$rel")"
    dest="$wt/"
    [ "$parent" != "." ] && dest="$wt/$parent/"
    case "$e" in
      */) echo "  mkdir -p \"$dest\" && cp -R \"$PRIMARY/$rel\" \"$dest\"" ;;
      *)  echo "  cp \"$PRIMARY\"/$rel \"$dest\"" ;;
    esac
  done <<<"$ENV_FILES"
}

NAME=""
INTERVAL=30
seen_pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    -*) shift ;;
    *)
      if [ "$seen_pos" -eq 0 ]; then NAME="$1"; seen_pos=1; else INTERVAL="$1"; fi
      shift ;;
  esac
done
[ -n "$NAME" ] || die 2 "usage: watch-worker.sh <agent-name> [interval] [--primary <path>]"

prev=""
copied=0
while true; do
  cur="$(herdr agent list 2>/dev/null | jq -r --arg n "$NAME" '.result.agents[] | select(.name==$n) | "\(.agent_status)|\(.foreground_cwd)"')"
  [ -n "$cur" ] || cur="missing|"
  status="${cur%%|*}"
  cwd="${cur#*|}"

  if [ "$cur" != "$prev" ]; then
    echo "WORKER $NAME $(date -u +%H:%M:%SZ) $cur"
    prev="$cur"
  fi

  # gotcha 11: when foreground_cwd flips to the new worktree, the PM must copy the
  # gitignored env/config files in. Print the exact commands once.
  if [ "$copied" -eq 0 ] && [ -n "$cwd" ] && [ "$cwd" != "$PRIMARY" ]; then
    case "$cwd" in
      */.claude/worktrees/*)
        print_env_copy_lines "$cwd"
        copied=1 ;;
    esac
  fi

  case "$status" in
    done|blocked|idle|exited|error|missing) exit 0 ;;
  esac
  sleep "$INTERVAL"
done
