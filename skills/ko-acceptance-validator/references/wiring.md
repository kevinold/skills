# Making the stages happen on their own

Nothing runs the spec or build stage unless an agent is told to. An install only copies this folder, so a project wires it in once, at one of two strengths. Both are advisory: they remind the agent and never block its work.

## 1. Agent instructions (any harness)

Paste this into the file your agents read, such as `AGENTS.md` or `CLAUDE.md`. Every harness that reads instructions gets it, though an agent can still skip it.

```markdown
When an implementation plan is ready, run the `ko-acceptance-validator` skill's spec stage on it before coding.
Once the change is running, run its build stage against it. Both are advisory and never block.
```

## 2. A post-tool hook (a harness that has hooks)

A hook fires deterministically, so it also reaches hands-off runs. Run these from the repo root, then commit what they write so everyone gets it. Use `--dry-run` to see the change first, and re-run to change it.

| Harness | Command | What it writes |
|---|---|---|
| Claude Code | `node <skill-dir>/scripts/wire-hooks.mjs claude-code` | One `PostToolUse` entry in `.claude/settings.json`, keeping everything else there |
| omp (oh-my-pi) | `node <skill-dir>/scripts/wire-hooks.mjs omp` | `.omp/hooks/post/acceptance-nudge.ts`, which omp finds by location |

`--global` wires the user's settings instead of this repo's: `~/.claude/settings.json` or `~/.omp/agent/hooks/post/`.

Checked against Claude Code and omp 18.13.1, each in a real session. omp's hook runs `node`, so node must be on the path there too.

To remove the wiring, delete that `PostToolUse` entry or that file.

## When a reminder fires

| Reminder | Fires after | Goes quiet when |
|---|---|---|
| Spec stage | A write or edit of a markdown file directly under a `plans/` directory, except `README.md` | A spec verdict for that plan's `.feature` is newer than the plan |
| Build stage | A command matching `gh pr create` or `git push`, in a checkout that has run the spec stage | The verdict for `HEAD` has been posted |

**The plan reminder reads nothing in the plan.** A plan's metadata changes as planning tools change, and a check keyed on a field those tools stop writing goes silent without anyone noticing. So it can fire on a draft, and the reminder tells the agent to skip it then.

**Choosing the build trigger.** `--build-on <regex>` replaces the default, and is matched against commands and skill names. A team that runs a browser check first might use `--build-on 'browser-check|gh pr create'`.

## Another harness

Any hook that can run a command and pass text to the agent works. After a tool finishes, call:

```text
node <skill-dir>/scripts/nudge.mjs event --tool <name> [--path <file>] [--command <shell command>] [--skill <name>] [--build-on <regex>]
```

Run it with cwd at the repo root. It prints a one-paragraph reminder or nothing, and always exits 0, so a broken nudge cannot stall an agent. Give it `--tool write` or `edit` with `--path` for a file change, and `--command` for a shell command. Send what it prints to the agent as added context. Pass arguments directly rather than through a shell, because a command can hold anything.
