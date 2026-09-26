#!/usr/bin/env bash
# usage: pull-primary.sh [--primary <path>] [--assert-hooks] [--mise] [--no-pull]
#   Fast-forward the primary checkout to origin/<baseBranch> (workers inherit its
#   .claude/settings.json at start — gotcha 1). --assert-hooks validates the
#   EFFECTIVE merged config `denyHook` across all three settings layers (R5, KTD10,
#   gotcha 4); with no denyHook configured it warns and skips the assertion;
#   --mise runs `mise trust && mise install` in the PM worktree (gotcha 7);
#   --no-pull skips the fetch/pull so --assert-hooks can be run against a prepared
#   primary/settings copy without a git remote.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

PRIMARY="$(primary_path "$@")" || exit 4
require_cmd git jq node
HERE="$(cd "$(dirname "$0")" && pwd -P)"
pm_cfg_load --primary "$PRIMARY" || exit $?
BASE="$(pm_cfg '.baseBranch')"
DENY_HOOK="$(printf '%s' "$PM_CFG_JSON" | jq -r '.denyHook // empty')"

# KTD7: the installed skill dir is a control only when it lives inside the
# primary (a project-level install); a global install is outside it and skipped.
SKILL_DIR="$(cd "$HERE/.." && pwd -P)"
PRIMARY_REAL="$(cd "$PRIMARY" && pwd -P)"
SKILL_REL=""
case "$SKILL_DIR/" in "$PRIMARY_REAL"/*) SKILL_REL="${SKILL_DIR#"$PRIMARY_REAL"/}" ;; esac

ASSERT_HOOKS=0
MISE=0
NO_PULL=0
for a in "$@"; do
  case "$a" in
    --assert-hooks) ASSERT_HOOKS=1 ;;
    --mise) MISE=1 ;;
    --no-pull) NO_PULL=1 ;;
  esac
done

pull_primary() {
  ( cd "$PRIMARY" || exit 4
    git fetch origin --quiet
    git pull --ff-only origin "$BASE" 2>&1 | tail -2
    echo "primary HEAD: $(git rev-parse --short HEAD)  branch: $(git branch --show-current)  origin/$BASE: $(git rev-parse --short "origin/$BASE")"
    git status --short | head -5
    # KTD3/KTD7: the paths `spine gate` refuses `config-dirty` for. Reported HERE,
    # before the spawn, so the operator sees WHICH control is uncommitted rather
    # than only the gate's refusal token.
    dirty="$(git status --porcelain -- .multi-worker-pm.json ${SKILL_REL:+"$SKILL_REL"})"
    if [ -n "$dirty" ]; then
      echo "CONFIG DIRTY: uncommitted changes under the PM's own controls — the start gate will refuse 'config-dirty':"
      printf '%s\n' "$dirty" | sed 's/^/  /'
    fi )
}

# Validate the effective merged deny hook (R5/KTD10). Not a bare key count in one
# file: it flattens PreToolUse hook commands across all three layers (last-wins,
# same view Claude loads) and requires the config's `denyHook` command wired
# exactly once, verbatim — no weakened or duplicate registration. "Weakened" is a
# command naming the hook's script (the basename of its last word) but not the
# exact configured command.
assert_hooks() {
  if [ -z "$DENY_HOOK" ]; then
    echo "WARN: no denyHook configured in .multi-worker-pm.json — skipping the deny-hook assertion" >&2
    return 0
  fi
  local expected="$DENY_HOOK" script
  script="$(basename "$(printf '%s' "${expected##* }" | tr -d "\"'")")"
  local layers=(
    "$PRIMARY/.claude/settings.json"
    "$PRIMARY/.claude/settings.local.json"
    "$HOME/.claude/settings.json"
  )
  local layer dupkeys cmds c exact=0 loose=0 seen=0
  echo "--- deny-hook assertion across settings layers ---"
  for layer in "${layers[@]}"; do
    if [ ! -f "$layer" ]; then
      echo "  layer absent: $layer"
      continue
    fi
    seen=$((seen + 1))
    # gotcha 4: a duplicated "PreToolUse" key silently drops the hook (last-wins).
    dupkeys="$(grep -c '"PreToolUse"' "$layer" || true)"
    if [ "${dupkeys:-0}" -gt 1 ]; then
      echo "DRIFT: $dupkeys \"PreToolUse\" keys in $layer (duplicate-key hazard — gotcha 4)" >&2
      exit 8
    fi
    if ! cmds="$(jq -r '.hooks.PreToolUse[]?.hooks[]?.command // empty' "$layer" 2>/dev/null)"; then
      echo "DRIFT: $layer is not valid JSON" >&2
      exit 8
    fi
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      [ "$c" = "$expected" ] && exact=$((exact + 1))
      case "$c" in *"$script"*) loose=$((loose + 1)) ;; esac
    done <<<"$cmds"
    echo "  $layer: $(printf '%s\n' "$cmds" | grep -c . ) PreToolUse hook command(s)"
  done
  if [ "$seen" -eq 0 ]; then
    echo "DRIFT: no settings layer found under $PRIMARY/.claude or $HOME/.claude" >&2
    exit 8
  fi
  echo "deny hook: exact-command matches=$exact  any-reference=$loose"
  if [ "$loose" -ne "$exact" ]; then
    echo "DRIFT: a deny-hook registration references the script but not its exact command (weakened)" >&2
    exit 8
  fi
  if [ "$exact" -ne 1 ]; then
    echo "DRIFT: deny hook '$expected' wired $exact time(s) across layers — must be exactly 1 (gotcha 4)" >&2
    exit 8
  fi
  echo "OK: deny hook wired exactly once with its exact command."
}

run_mise() {
  require_cmd mise
  echo "mise trust + install in PM worktree: $PWD"
  mise trust
  mise install
}

[ "$NO_PULL" -eq 1 ] || pull_primary
[ "$ASSERT_HOOKS" -eq 1 ] && assert_hooks
[ "$MISE" -eq 1 ] && run_mise
exit 0
