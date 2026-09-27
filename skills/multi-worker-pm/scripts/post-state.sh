#!/usr/bin/env bash
# usage: post-state.sh <issue> <state> [text] [--primary <path>]
#   Post an append-only `state:` comment on a lane sub-issue. Rejects any state
#   outside the posted vocabulary (R21/KTD4). Repo is inferred from cwd, or from
#   --primary when given.
set -euo pipefail

# shellcheck source=lib.sh disable=SC1091
. "$(dirname "$0")/lib.sh"

require_cmd gh node
HERE="$(cd "$(dirname "$0")" && pwd)"
PRIMARY="$(primary_path_opt "$@")"

ISSUE=""
STATE=""
TEXT=""
pos=0
while [ $# -gt 0 ]; do
  case "$1" in
    --primary) shift 2 ;;
    --primary=*) shift ;;
    -*) shift ;;
    *)
      case "$pos" in
        0) ISSUE="$1" ;;
        1) STATE="$1" ;;
        2) TEXT="$1" ;;
      esac
      pos=$((pos + 1))
      shift ;;
  esac
done
[ -n "$ISSUE" ] && [ -n "$STATE" ] || die 2 "usage: post-state.sh <issue> <state> [text] [--primary <path>]"

# The loop above consumed all of "$@", so the digest call below has to be handed
# --primary again — otherwise it reads the config of whatever cwd this ran from
# and stamps a digest describing the wrong repo (empty-array safe under set -u).
set_primary_args

case "$STATE" in
  spawned|blocked-infra|blocked|blocked-scope|base-verified|chore-verified|base-regressed|closed) ;;
  *) die 2 "invalid state '$STATE' (allowed: spawned blocked-infra blocked blocked-scope base-verified chore-verified base-regressed closed)" ;;
esac

BODY="state: $STATE"
[ -n "$TEXT" ] && BODY="state: $STATE — $TEXT"

# `spawned` and the two verified states carry the config digest (KTD3): the start
# gate compares the primary's digest against the one on the campaign's last
# `spawned` comment and refuses `config-drift` when a committed config change
# fast-forwarded in mid-campaign. Fail closed — an unrecorded digest would make
# that comparison silently pass. The suffix goes LAST so any sha in $TEXT (the
# merge commit a bar posting records) is still the first sha in the body.
case "$STATE" in
  spawned|base-verified|chore-verified)
    DIGEST="$(node "$HERE/run.mjs" spine config --digest ${primary_args[@]+"${primary_args[@]}"})" ||
      die 2 "could not read the config digest — refusing to post '$STATE' without it (KTD3)"
    BODY="$BODY config=$DIGEST"
    ;;
esac

if [ -n "$PRIMARY" ]; then
  ( cd "$PRIMARY" && gh issue comment "$ISSUE" --body "$BODY" )
else
  gh issue comment "$ISSUE" --body "$BODY"
fi
echo "posted state '$STATE' on #$ISSUE"
