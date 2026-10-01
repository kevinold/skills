#!/usr/bin/env bash
# shellcheck shell=bash
# lib.sh — shared helpers for the multi-worker-pm spine side-effect scripts.
# SOURCE this file, don't execute it: `. "$(dirname "$0")/lib.sh"`.
#
# Why a lib: every spine script needs the same four things and none of them may be
# hardcoded (KTD2, gotcha 2 — the worktree git guard refuses inline `git -C`, `$VAR`,
# heredocs, so multi-step ops live in files like this one):
#   - primary_path      resolve the primary checkout from --primary/$SPINE_PRIMARY, never a literal
#   - pm_cfg             read a repo fact from the validated config, never a restated default
#   - require_cmd        fail with a named message when a CLI is missing (gh/jq/node/herdr)
#   - json_get           parse a jq field, fail-closed on empty (herdr/gh surface drift, gotcha 10)
#   - check_no_unsent_input   the shared gotcha-9 guard close-lane.sh AND clean-panes.sh both call
#   - in_worker_context / refuse_worker_context   the R24 worker/roster refusal
#
# Named non-zero exit codes used across the scripts:
#   2 usage/bad-arg   3 agent-not-ready / no-run   4 primary path unset/invalid
#   5 missing command 6 worker/roster refusal (R24) 7 herdr/gh JSON drift
#   8 hook drift (--assert-hooks)  9 unsent input present (close refused, gotcha 9)

# --- primary checkout resolution (never hardcode a path — gotcha 1/2) --------

# Optional: print the resolved primary path, or nothing when unset. For scripts
# that only need it to give gh/git a repo context.
primary_path_opt() {
  local p="${SPINE_PRIMARY:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --primary) p="${2:-}"; shift 2 ;;
      --primary=*) p="${1#--primary=}"; shift ;;
      *) shift ;;
    esac
  done
  printf '%s' "$p"
}

# Required: print the resolved primary path or return 4 with a named message.
primary_path() {
  local p
  p="$(primary_path_opt "$@")"
  if [ -z "$p" ]; then
    echo "error: primary checkout path not set (pass --primary <path> or set SPINE_PRIMARY)" >&2
    return 4
  fi
  if [ ! -e "$p/.git" ]; then
    echo "error: --primary '$p' is not a git checkout (.git missing)" >&2
    return 4
  fi
  printf '%s\n' "$p"
}

# Set the `primary_args` array to the `--primary <path>` fragment a run.mjs (or
# sibling-script) call needs, or to empty when $PRIMARY is unset. Callers expand
# it as ${primary_args[@]+"${primary_args[@]}"} — an empty array is an unset
# variable under `set -u`. The explicit `return 0` keeps the unset case from
# tripping `set -e` at the call site.
set_primary_args() {
  primary_args=()
  [ -n "${PRIMARY:-}" ] && primary_args=(--primary "$PRIMARY")
  return 0
}

# --- small guards ------------------------------------------------------------

die() { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || {
      printf "error: required command '%s' not found on PATH\n" "$c" >&2
      return 5
    }
  done
}

# Extract a jq expression from JSON on stdin; die (7) on an empty/null result so a
# caller never loops on a "missing" it printed itself (herdr surface drift, gotcha 10).
json_get() {
  local expr="$1" what="${2:-value}" out
  if ! out="$(jq -er "$expr" 2>/dev/null)"; then
    die 7 "could not read $what from JSON (herdr/gh surface drift? run 'herdr --skill | head -40')"
  fi
  printf '%s\n' "$out"
}

# --- per-repo config (KTD1) --------------------------------------------------
# The shell side NEVER reads .multi-worker-pm.json and never restates a default:
# every repo fact comes from `run.mjs spine config`, which applies the same
# DEFAULTS and the same validation, so a shell helper cannot diverge from the
# loader and fails on exactly the same errors. Directory of this lib, resolved at
# source time so pm_cfg works whatever the caller's cwd is.
PM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load the validated config once. Call this at a script's TOP LEVEL (not inside a
# command substitution) so the digest line is printed once per script; pm_cfg
# loads inline if you don't. Args are forwarded to run.mjs (--primary/--config).
pm_cfg_load() {
  [ -n "${PM_CFG_JSON:-}" ] && return 0
  PM_CFG_JSON="$(node "$PM_LIB_DIR/run.mjs" spine config "$@")" || return $?
  return 0
}

# pm_cfg <jq-path> [--primary <path>] — print one config value. On a config error
# the loader has already named every problem on stderr; this prints nothing and
# passes the exit code up.
pm_cfg() {
  local expr="$1"; shift
  pm_cfg_load "$@" || return $?
  printf '%s\n' "$PM_CFG_JSON" | json_get "$expr" "config value $expr"
}

# --- gh with the primary checkout as cwd -------------------------------------
# Run gh inside the primary checkout when $PRIMARY is set (so repo context
# resolves from a worktree), else in the current dir. Callers resolve PRIMARY via
# primary_path/primary_path_opt first; the ${PRIMARY:-} guard keeps it safe under
# `set -u` when a caller left it unset. Shared by every spine script that calls gh.
gh_() {
  if [ -n "${PRIMARY:-}" ]; then ( cd "$PRIMARY" && gh "$@" ); else gh "$@"; fi
}

# --- shared unsent-input check (gotcha 9 / R24 / R26) ------------------------
# Reads a pane's last 40 lines and returns:
#   0  the input box is clear         → safe to close
#   1  unsent operator input present  → refuse to close (or unreadable → fail closed)
# close-lane.sh and clean-panes.sh BOTH call this — do not re-implement it elsewhere.
#
# ponytail: heuristic over the TUI capture. The bottom input box is the last line
# carrying a `>` prompt marker; word characters after that marker that are not the
# placeholder hint are treated as unsent input. Fails closed so a herdr render
# change refuses the close rather than force-closing over a draft. Tune the marker
# and the placeholder cases below if herdr's capture format changes.
check_no_unsent_input() {
  local name="$1" recent box typed
  if ! recent="$(herdr agent read "$name" --source recent --lines 40 2>/dev/null)"; then
    echo "unsent-input check: cannot read pane '$name' — failing closed (treat as unsent input present)" >&2
    return 1
  fi
  # The TUI renders its prompt with a heavy-arrow `❯`; normalize it to the ASCII
  # `>` this heuristic keys on so a clean pane is not mistaken for a render change
  # and refused. ponytail: literal glyph swap via bash builtin
  # (no subprocess); extend the set here if herdr changes its prompt marker again.
  recent="${recent//❯/>}"
  box="$(printf '%s\n' "$recent" | grep '>' | tail -1)"
  if [ -z "$box" ]; then
    # A genuinely empty capture is clear; a non-empty transcript with NO prompt
    # marker is the render change the docstring anticipates — fail closed rather
    # than assume the box is clear and force-close over a draft (gotcha 9 / R26).
    [ -z "$recent" ] && return 0
    echo "unsent-input check: no prompt marker in pane '$name' capture — failing closed" >&2
    return 1
  fi
  typed="${box##*>}"                                       # text after the last prompt marker
  typed="$(printf '%s' "$typed" | tr -cd '[:alnum:]')"     # keep only word chars (drops frame/space)
  case "$typed" in
    "") return 0 ;;                                         # empty box → clear
    Try*|*shortcuts*) return 0 ;;                           # known placeholder hints → clear
    *) echo "unsent input detected in pane '$name'" >&2; return 1 ;;
  esac
}

# --- shared pane close (gotcha 10) --------------------------------------------
# Close a worker's herdr pane BY ITS PANE ID. The live CLI takes a pane id, not
# `--name`: `pane close --name <name>` was a silent no-op that left the agent alive
# under a deleted worktree while the script printed success. Resolve the id from
# `agent list`, close it, then VERIFY — the name frees ~2 s after a real close
# (gotcha 10), so re-read once after a short wait and report honestly instead of
# claiming success unconditionally. close-lane.sh AND clean-panes.sh both call this.
#   0  the agent is gone (closed now, or already absent)
#   1  the pane is still listed after the attempt (a named warning went to stderr)
# The close is best-effort: a caller that must still remove the worktree/credentials
# (R26) invokes it as `close_pane_by_agent "$n" || true` and never claims success on 1.
close_pane_by_agent() {
  local name="$1" pane attempt list
  # Read the roster once for resolution. A reply that is NOT a well-formed
  # `.result.agents` array is herdr drift, not an empty roster — never read it as
  # "agent gone" (that would be a false success). Warn and stop.
  list="$(herdr agent list 2>/dev/null || true)"
  if ! printf '%s' "$list" | jq -e '.result.agents | type == "array"' >/dev/null 2>&1; then
    echo "warning: pane close for '$name' — could not read the agent roster (herdr unresponsive?); close it by hand: herdr agent list then herdr pane close <pane_id>" >&2
    return 1
  fi
  pane="$(printf '%s' "$list" | jq -r --arg n "$name" '.result.agents[] | select(.name==$n) | .pane_id' | head -1)"
  if [ -z "$pane" ] || [ "$pane" = "null" ]; then
    echo "pane close: no agent named '$name' in the roster (already gone?)"
    return 0
  fi
  herdr pane close "$pane" 2>/dev/null || true
  # Verify. Only a well-formed roster that no longer lists the agent proves the
  # close (the name frees ~2 s after a real close — gotcha 10, hence one retry). An
  # empty/garbled verify reply is "unknown", so it falls through to the honest warning.
  for attempt in 1 2; do
    list="$(herdr agent list 2>/dev/null || true)"
    if printf '%s' "$list" | jq -e '.result.agents | type == "array"' >/dev/null 2>&1 \
      && ! printf '%s' "$list" | jq -e --arg n "$name" '.result.agents[] | select(.name==$n)' >/dev/null 2>&1; then
      echo "pane closed for $name ($pane)"
      return 0
    fi
    if [ "$attempt" -eq 1 ]; then sleep 2; fi
  done
  echo "warning: pane close did not clear agent '$name' — pane $pane still listed (or herdr unverifiable). Close it by hand: herdr pane close $pane" >&2
  return 1
}

# --- worker/roster context refusal (R24) -------------------------------------
# A worker is started by /ce-worktree into a linked worktree under .claude/worktrees/
# and is named w<N> in the roster; the PM drives from the primary's main checkout.
# Any one signal → worker context (return 0):
#   - cwd under .claude/worktrees/           (where /ce-worktree puts workers)
#   - SPINE_ROLE=worker                       (explicit opt-in)
#   - a w<N> herdr agent name in the env      (roster naming)
# ponytail: cwd is the reliable structural signal; the env-var names are best-effort.
# This is defence-in-depth behind KTD3's real control (a PM-session-scoped allow rule
# workers never inherit) — not the sole gate.
in_worker_context() {
  case "$PWD" in
    */.claude/worktrees/*) return 0 ;;
  esac
  [ "${SPINE_ROLE:-}" = "worker" ] && return 0
  local v
  for v in "${HERDR_AGENT:-}" "${HERDR_AGENT_NAME:-}" "${HERDR_NAME:-}"; do
    [ -n "$v" ] && printf '%s' "$v" | grep -Eq '^w[0-9]+$' && return 0
  done
  return 1
}

refuse_worker_context() {
  if in_worker_context; then
    echo "error: refusing to run '${1:-this command}' from a worker/roster context (R24)." >&2
    echo "  This authorization is PM-session-scoped; a worker must never invoke it." >&2
    exit 6
  fi
}
