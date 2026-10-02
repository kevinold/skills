#!/bin/bash
# set-agent-label.sh — the single writer for multi-worker-pm agent-lifecycle
# labels. The skill calls this; it never inlines `gh issue edit`.
#
# Usage:
#   set-agent-label.sh bootstrap                        # create the new labels (idempotent)
#   set-agent-label.sh claim   <n> [--pr] [--dry-run]   # +agent-in-progress -agent-ready
#   set-agent-label.sh review  <n> [--pr] [--dry-run]   # +agent-in-review   -agent-in-progress
#   set-agent-label.sh merged  <n> [--pr] [--dry-run]   # +agent-merged      -agent-in-review
#   set-agent-label.sh blocked <n> [--pr] [--dry-run]   # +agent-blocked     -agent-in-progress
#
# --pr       target a pull request (gh pr edit/view) instead of an issue.
# --dry-run  print the gh mutations it would make and exit 0 without mutating.
#
# `claim` is a best-effort lease: it pre-reads the item's labels and exits 3 if
# an in-flight agent label is already present ("already-claimed"), so the caller
# spawns nothing and re-selects. It is not an atomic lock — see SKILL.md
# "Agent-lifecycle labels" for the pre-read→add race window.
#
# ponytail: labels are a lease, not a lock — the tiny race is documented, not engineered away.

set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"   # require_cmd, die — shared with the spine side-effect scripts

# This tool is repo-scoped: every gh call passes --repo explicitly, so it needs
# none of lib.sh's --primary / gh_ worktree plumbing — a label edit is
# repo-global, not worktree-local. The repo is DERIVED from the checkout (R11),
# never a literal; a linked worktree resolves the same repo as its primary.
# AGENT_LABEL_REPO stays an explicit override.
REPO="${AGENT_LABEL_REPO:-}"
if [ -z "$REPO" ]; then
  require_cmd gh || exit $?
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || REPO=""
  [ -n "$REPO" ] || die 2 "cannot resolve the repo: 'gh repo view' failed here and AGENT_LABEL_REPO is unset"
fi

usage() {
  echo "usage: set-agent-label.sh <bootstrap|claim|review|merged|blocked> [<number>] [--pr] [--dry-run]" >&2
  exit 2
}

cmd="${1:-}"
shift || true

DRY_RUN=0
KIND="issue"
NUMBER=""
for arg in "$@"; do
  case "$arg" in
    --pr) KIND="pr" ;;
    --dry-run) DRY_RUN=1 ;;
    -*) echo "set-agent-label: unknown flag '$arg'" >&2; usage ;;
    *) NUMBER="$arg" ;;
  esac
done

# Execute a gh mutation, or just print it under --dry-run.
run_gh() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY-RUN: gh'
    printf ' %q' "$@"
    printf '\n'
  else
    gh "$@"
  fi
}

bootstrap() {
  require_cmd gh
  run_gh label create agent-in-review --repo "$REPO" --color 0e8a16 \
    --description "Agent lifecycle: PR open and CI-green, awaiting merge" --force
  run_gh label create agent-merged --repo "$REPO" --color 6f42c1 \
    --description "Agent lifecycle: the PR merged" --force
  run_gh label create agent-blocked --repo "$REPO" --color b60205 \
    --description "Agent lifecycle: escalated/failed, needs a human" --force

  # --limit 200 is load-bearing: gh label list defaults to 30 rows and the
  # agent-* labels sort into the tail on this 36+-label repo, so a limitless
  # read would report a false "missing".
  local existing
  existing="$(gh label list --repo "$REPO" --limit 200 --json name --jq '.[].name')"
  if ! grep -qx agent-ready <<<"$existing"; then
    die 1 "agent-ready label missing — run /triage-backlog bootstrap first"
  fi
  if ! grep -qx agent-in-progress <<<"$existing"; then
    run_gh label create agent-in-progress --repo "$REPO" --color 772e01 \
      --description "Agent lifecycle: a worker is actively implementing" --force
  fi
  echo "bootstrap: agent-lifecycle labels ready"
}

# Add one label and remove one, after a lease pre-read for `claim`.
transition() {
  local add="$1" remove="$2"
  require_cmd gh
  [ -n "$NUMBER" ] || die 2 "$cmd needs a <number>"

  # Lease pre-read (live mode only): refuse if already claimed by an agent.
  # grep -x is exact-line match (never a prefix glob); the alternation is kept in
  # sync BY HAND with select.mjs's IN_FLIGHT_AGENT_LABELS (source of truth) — the
  # drift guard in select.test.mjs enforces it.
  if [ "$cmd" = claim ] && [ "$DRY_RUN" -eq 0 ]; then
    local current lbl
    current="$(gh "$KIND" view "$NUMBER" --repo "$REPO" --json labels --jq '.labels[].name')"
    lbl="$(grep -xE 'agent-in-progress|agent-in-review|agent-merged|agent-blocked' <<<"$current" | head -1 || true)"
    [ -z "$lbl" ] || { echo "already-claimed: $KIND #$NUMBER carries '$lbl'" >&2; exit 3; }
  fi

  run_gh "$KIND" edit "$NUMBER" --repo "$REPO" --add-label "$add" --remove-label "$remove"
  # ponytail: deliberate ground-truth re-read — echo the ACTUAL resulting label
  # set (not just +add/-remove) so the PM's audit log shows the real state,
  # including any co-existing labels. One extra gh call, off the ~60s-tick path.
  if [ "$DRY_RUN" -eq 0 ]; then
    echo "#$NUMBER $(gh "$KIND" view "$NUMBER" --repo "$REPO" --json labels --jq '[.labels[].name] | join(",")')"
  fi
}

case "$cmd" in
  bootstrap) bootstrap ;;
  claim) transition agent-in-progress agent-ready ;;
  review) transition agent-in-review agent-in-progress ;;
  merged) transition agent-merged agent-in-review ;;
  blocked) transition agent-blocked agent-in-progress ;;
  "" | -h | --help | help) usage ;;
  *) echo "set-agent-label: unknown subcommand '$cmd'" >&2; usage ;;
esac
