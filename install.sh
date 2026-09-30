#!/usr/bin/env bash
# Install kevinold/skills, then offer claude-video (the `watch` skill), which
# meeting-notes needs to read meeting recordings.
#
#   curl -fsSL https://raw.githubusercontent.com/kevinold/skills/main/install.sh | bash
#   ./install.sh [skills add args...] [--with-video | --no-video]
#
# Every argument except --with-video/--no-video goes to `npx skills add`.
# The agent and scope flags (-a/--agent, -g/--global, -y/--yes) also go to the
# claude-video install so both land in the same place.
set -euo pipefail

SOURCE="${KEVINOLD_SKILLS_SOURCE:-kevinold/skills}"
VIDEO_SOURCE="bradautomates/claude-video"

video=ask
args=()
shared=()
skills=()
while [ $# -gt 0 ]; do
  case "$1" in
    --with-video) video=yes ;;
    --no-video) video=no ;;
    -g | --global | -y | --yes) args+=("$1"); shared+=("$1") ;;
    -a | --agent)
      args+=("$1"); shared+=("$1")
      while [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; do shift; args+=("$1"); shared+=("$1"); done ;;
    -s | --skill)
      args+=("$1")
      while [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; do shift; args+=("$1"); skills+=("$1"); done ;;
    *) args+=("$1") ;;
  esac
  shift
done

npx -y skills add "$SOURCE" ${args[@]+"${args[@]}"}

# Only meeting-notes uses claude-video; skip the offer when it wasn't installed.
if [ ${#skills[@]} -gt 0 ] && [[ " ${skills[*]} " != *" meeting-notes "* ]]; then
  exit 0
fi

if [ "$video" = ask ]; then
  # Read from the terminal, not stdin, so `curl ... | bash` can still prompt.
  if { exec 3<"${KEVINOLD_SKILLS_TTY:-/dev/tty}"; } 2>/dev/null; then
    printf 'Also install claude-video (%s) so meeting-notes can read meeting recordings? [Y/n] ' "$VIDEO_SOURCE" >&2
    read -r reply <&3 || reply=
    exec 3<&-
    case "$reply" in [nN]*) video=no ;; *) video=yes ;; esac
  else
    video=no
    echo "Skipped claude-video (no terminal to ask). Re-run with --with-video, or: npx skills add $VIDEO_SOURCE"
  fi
fi

if [ "$video" = yes ]; then
  npx -y skills add "$VIDEO_SOURCE" ${shared[@]+"${shared[@]}"}
fi
