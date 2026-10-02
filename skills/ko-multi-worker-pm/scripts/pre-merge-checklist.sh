#!/usr/bin/env bash
# usage: pre-merge-checklist.sh <pr> <sub-issue> [--authors csv] [--primary <path>]
#   Gather the lane PR facts and the lane YAML, then hand them to
#   `run.mjs spine checklist` — which runs the R22 PR-identity check, the R23
#   protected-path boundary, and the R10 subject, skip-cd, allowed-paths, and
#   Closes checks. Every rule lives in spine.mjs (KTD2); this only gathers/plumbs.
#   Prints the checklist result; exits non-zero (2) on any violation → the PR is
#   NOT merge-ready.
#
#   Optional: set SPINE_PARCEL_WATCHER_COUNT to feed the R10 lockfile-integrity
#   floor (KTD11) when package-lock.json changed on an opted-in lane.
#   ponytail: the count is supplied, not computed here — deriving it needs the
#   merged lockfile (>1MB); a follow-up can compute it from the primary post-merge.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

HERE="$(cd "$(dirname "$0")" && pwd)"
require_cmd gh jq node
PRIMARY="$(primary_path_opt "$@")"

PR=""
SUB=""
AUTHORS="${SPINE_AUTHORS:-}"
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    --authors) AUTHORS="${2:-}"; shift 2 ;;
    --authors=*) AUTHORS="${1#--authors=}"; shift ;;
    -*) shift ;;
    *)
      case "$pos" in
        0) PR="$1" ;;
        1) SUB="$1" ;;
      esac
      pos=$((pos + 1)); shift ;;
  esac
done
[ -n "$PR" ] && [ -n "$SUB" ] || die 2 "usage: pre-merge-checklist.sh <pr> <sub-issue> [--authors csv] [--primary <path>]"
case "$PR" in ''|*[!0-9]*) die 2 "pr must be numeric (got '$PR')" ;; esac
case "$SUB" in ''|*[!0-9]*) die 2 "sub-issue must be numeric (got '$SUB')" ;; esac

# gh_ comes from lib.sh (runs gh in the primary checkout when --primary is set).

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The lane YAML contract lives in the sub-issue body.
gh_ issue view "$SUB" --json body -q .body >"$TMP/lane-body.md"

# R22 identity fields + subjects (commits) / files / body for the checklist.
gh_ pr view "$PR" \
  --json commits,files,body,author,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository \
  >"$TMP/pr.json"

extra=()
[ -n "$AUTHORS" ] && extra+=(--authors "$AUTHORS")
[ -n "${SPINE_PARCEL_WATCHER_COUNT:-}" ] && extra+=(--parcel-watcher-count "$SPINE_PARCEL_WATCHER_COUNT")
# --primary must reach the checklist: it decides which config's subject prefixes
# and skip-cd policy the lane is judged by (R3/R5).
set_primary_args

if node "$HERE/run.mjs" spine checklist ${primary_args[@]+"${primary_args[@]}"} \
     --sub-issue "$SUB" \
     --lane-body-file "$TMP/lane-body.md" \
     --pr-file "$TMP/pr.json" \
     ${extra[@]+"${extra[@]}"}; then
  echo "pre-merge checklist: PR #$PR (sub-issue #$SUB) is merge-ready." >&2
else
  rc=$?
  echo "pre-merge checklist: PR #$PR (sub-issue #$SUB) is NOT merge-ready (violations above)." >&2
  exit "$rc"
fi
