# skills

Kevin Old's shared coding-agent skills. One command installs them into every agent a project uses: Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Pi, and the other agents the [`skills` CLI](https://www.npmjs.com/package/skills) supports.

## Install

```bash
npx skills add kevinold/skills                          # pick skills and agents interactively
npx skills add kevinold/skills --all                    # every skill, every detected agent, no prompts
npx skills add kevinold/skills -s multi-worker-pm       # one skill
npx skills add kevinold/skills -a claude-code codex     # specific agents
npx skills add kevinold/skills -g                       # user-level instead of this project
npx skills update                                       # pull the latest versions
```

A project-level install lands in the repo, for example `.claude/skills/<name>/` or `.agents/skills/<name>/`. Commit it so teammates' agents get the same version.

## Skills

| Skill | What it does |
| --- | --- |
| [`multi-worker-pm`](skills/multi-worker-pm/SKILL.md) | Runs one agent session as an autonomous PM over up to 3 parallel worker agents in herdr panes. It works backlog issues, tends stalled Renovate PRs, or drives a spine epic's sub-issues as gated sequential lanes. |
| [`meeting-notes`](skills/meeting-notes/SKILL.md) | Files a meeting transcript into `docs/meeting-notes/<series>/<date>/` and writes a PM-grade summary with speaker and timestamp attributions. It can watch the recording to add a PII-gated screen-share timeline, and ends with PRFAQ refinements and candidates. |
| [`prfaq`](skills/prfaq/SKILL.md) | Writes a status-honest PRFAQ (Markdown plus a self-contained HTML twin) in `docs/prfaqs/`, or applies a meeting's refinements to an existing one. |

## multi-worker-pm

### Prerequisites

| Requirement | Why |
| --- | --- |
| [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) in the worker agent | Workers run `/ce-worktree` + `/lfg` (issue and spine lanes) or `/ce-babysit-pr` (renovate lane). |
| `gh`, authenticated | Issue/PR selection, labels, rulesets, workflow runs. The repo comes from `gh`'s auto-detected `{owner}/{repo}`, so run from inside the target checkout. |
| `node` ≥ 22 | Runs the deterministic helpers in `scripts/`. |
| `jq`, `git`, `bash` | Shell helpers. |
| `herdr` | Pane/tab/agent runtime for workers. Not needed for `--dry-run`. |

### Configuration

The PM reads `.multi-worker-pm.json` at the root of the primary checkout. Without it, neutral defaults apply:
- base branch `main`
- at least one check must succeed and none may fail (skipped checks pass). Zero reported checks is never green.
- the post-merge bar watches the base-branch push run of `ci.yml`

Spine mode refuses to start until `identity.expectedAuthors` is set, because those accounts are the only ones trusted to post lane `state:` comments.

Copy [`config.example.json`](skills/multi-worker-pm/config.example.json) to start. The keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseBranch` | `"main"` | Branch lanes merge into and the post-merge bar watches. |
| `protectedBranches` | `[baseBranch]` | Branches workers must never write to directly. Preflight checks their rulesets, and always checks the base branch. |
| `subjects.preview` / `subjects.chore` | conventional prefixes | Commit-subject prefixes allowed per lane kind. `skipCd` is `ignored`, `forbidden` or `required`. |
| `checks.required` | `[]` | Check-name substrings that must all succeed. Empty means at least one check succeeded and none failed; skipped and neutral checks pass. |
| `checks.previewContext` | `null` | Extra status context preview lanes must carry. |
| `identity.expectedAuthors` | none | GitHub logins whose `state:` comments spine trusts. Required for spine. |
| `postMergeBar.preview` / `.chore` | push mode, `ci.yml` | `push` watches the base-branch push run at the merge commit. `dispatch` runs `workflow_dispatch` with `inputs`, `runs` times. |
| `postMergeBar.maxRuns` / `.timeoutMinutes` | `3` / `60` | Bar limits. |
| `workerEnvFiles` | `[]` | Gitignored files copied into worker worktrees. They are treated as credential paths. |
| `dangerPaths` | `[]` | Extra paths that mark an issue dangerous, on top of the built-in list (workflows, hooks, lockfiles, secrets). |
| `protectedPaths` | `[]` | Extra paths a spine lane PR may never touch. |
| `workerKind` | `"claude"` | `herdr agent start --kind` for workers. The worker prompt sends compound-engineering commands, so the agent must have them. |
| `renovate.branchPrefixes` / `.securityPrefixes` | `["renovate/"]` / `[]` | Renovate head-branch prefixes the renovate lane tends; security ones sort first. |
| `denyHook` | none | A hook command `pull-primary.sh --assert-hooks` requires in the Claude Code settings. Only supported with `workerKind: "claude"`. |

The dispatch-mode bar starts right after merge and does not wait for deploys. A dispatched workflow that tests a deployed environment has to wait for its own deploy.

Project-level installs:
- Commit the installed skill directory before running spine mode. The start gate refuses when the PM's own files are uncommitted.
- Exclude `.claude/skills/**` and `.agents/skills/**` from your test runner. The skill ships its own tests.

Updating the skill during a spine campaign changes the config digest, so the next lane's start gate refuses with `config-drift`. Pass `--accept-config <sha12>` to continue on the new version deliberately.

### Usage

```text
/multi-worker-pm --dry-run                  # preview what would spawn, no pool
/multi-worker-pm                            # issue lane, pool cap 3
/multi-worker-pm --mode renovate            # tend stalled dependency PRs
/multi-worker-pm --mode spine <epic|plan>   # sequential gated lanes for one epic
```

## meeting-notes

### Prerequisites

| Requirement | Why |
| --- | --- |
| `textutil` (macOS) or `pandoc` | Converts `.docx` transcript exports. Without either, the docx is still filed and the summary notes the transcript wasn't extractable. |
| [`watch`](https://github.com/bradautomates/claude-video) (optional) | Needed only to read a meeting recording. Install with `npx skills add bradautomates/claude-video`, or in Claude Code `/plugin marketplace add bradautomates/claude-video` then `/plugin install watch@claude-video`. Without it, recordings are skipped with an install hint; screenshots still work. |
| `ffmpeg`, `ffprobe`, `yt-dlp`, `python3` | Used by `watch`. Its setup script installs them on first run. |
| [`prfaq`](#prfaq) (recommended) | Turns the summary's PRFAQ candidates and refinements into documents. |

The video pass always runs `watch` with `--no-whisper`, so meeting audio is never sent to a transcription API.

### Configuration

None. The skill writes to `docs/meeting-notes/` and, when the repo has one, updates `CONCEPTS.md` with the meeting's vocabulary decisions.

### Usage

```text
file this meeting                                # a .docx/.md/.txt at the docs/meeting-notes/ root
file this meeting and watch ~/Movies/sync.mp4    # add the screen-share timeline
add the screen timeline for product-sync 2026-06-08 from <recording or screenshots>
```

Committed frames go through a PII gate. Only diagrams, public pages and dev/test data are proposed, and you approve the list once before anything is copied into `assets/`. Recordings are never copied into the repo.

## prfaq

### Prerequisites

None beyond the agent. `.docx` inputs use `textutil` or `pandoc`, as in meeting-notes.

### Configuration

None. PRFAQs live in `docs/prfaqs/`, indexed by `docs/prfaqs/README.md`.

### Usage

```text
/prfaq <candidate from a meeting summary>
/prfaq docs/meeting-notes/<series>/<date>/<date>-prfaq-refinements.md   # update existing PRFAQs
/prfaq <feature discussed in this conversation>
```

## Adding a skill

1. Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter. Put any scripts or references it needs inside that folder, and refer to them relative to the skill directory. Installs copy only the folder.
2. Check discovery: `npx skills add . --list`.
3. Add tests as `skills/<name>/**/*.test.mjs`, or in `test/` for checks that span skills. `npm test` runs them under a globally frozen clock (`test/setup.mjs`).
4. Add a row to the Skills table above.

## Development

```bash
npm install
npm test
```

## License

MIT
