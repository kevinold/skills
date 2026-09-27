import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "lib.sh");
const CLOSE_LANE = join(HERE, "close-lane.sh");
const CLEAN_PANES = join(HERE, "clean-panes.sh");

// OS temp, NOT under .claude/worktrees: close-lane.sh refuses a worker/roster
// context (R24) keyed on a cwd under .claude/worktrees, and this test file itself
// sits under one when the suite runs in a linked worktree. Every spawn uses
// cwd = SCRATCH so the refusal never fires spuriously.
const SCRATCH = mkdtempSync(join(tmpdir(), "pm-close-lane-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let seq = 0;
const scratch = (name) => join(SCRATCH, `${seq++}-${name}`);

// A stub-bin dir whose scripts shadow the real herdr/git on PATH and append every
// invocation to one log. Each `stubs` value is bash appended after the log line.
const stubBin = (stubs) => {
  const dir = mkdtempSync(join(SCRATCH, "bin-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >>"${log}"\n${body}\n`, { mode: 0o755 });
  }
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } };
};

const primaryRoot = () => {
  const root = scratch("primary");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
};

// A never-failing git stub: every `git worktree …` becomes a logged no-op so the
// test drives the pane-close path without a real repo mutation.
const GIT_OK = "true";

// herdr stub for the pane-close path. `agent list` reports w1 (pane id w1:p1V)
// until a marker file exists; `pane close <id>` writes that marker ONLY when
// called with the real pane id. `mode:"noop"` never writes it — the agent
// survives every close, so the script must say so instead of a false success.
const herdrPaneStub = (marker, { mode = "works" } = {}) =>
  [
    `present='{"result":{"agents":[{"name":"w1","agent_status":"idle","pane_id":"w1:p1V"}]}}'`,
    `gone='{"result":{"agents":[]}}'`,
    `case "$1 $2" in`,
    `  "agent list") if [ -f "${marker}" ]; then printf '%s\\n' "$gone"; else printf '%s\\n' "$present"; fi ;;`,
    mode === "works"
      ? `  "pane close") [ "$3" = "w1:p1V" ] && : > "${marker}"; true ;;`
      : `  "pane close") true ;;`,
    `  *) true ;;`,
    `esac`,
  ].join("\n");

const closeLane = (env) =>
  spawnSync("bash", [CLOSE_LANE, "w1", scratch("worktree"), "--primary", primaryRoot()], {
    encoding: "utf8",
    cwd: SCRATCH,
    env,
    timeout: 20_000,
  });

describe("close-lane.sh pane close", () => {
  it("resolves the pane id from `agent list` and closes by id, never `--name`", () => {
    const marker = scratch("closed");
    const { log, env } = stubBin({ herdr: herdrPaneStub(marker), git: GIT_OK });
    const r = closeLane(env);
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/herdr pane close w1:p1V/); // closed by the resolved pane id
    expect(calls).not.toMatch(/pane close --name/); // never the broken --name form
    expect(r.stdout).toMatch(/pane closed for w1/); // honest success once the agent is gone
    expect(calls).toMatch(/git worktree remove/); // terminal-path worktree removal still runs
  });

  it("reports honestly when the pane survives, instead of printing success", () => {
    const marker = scratch("never");
    const { log, env } = stubBin({ herdr: herdrPaneStub(marker, { mode: "noop" }), git: GIT_OK });
    const r = closeLane(env);
    expect(r.status).toBe(0); // terminal-path cleanup still completes (best-effort close)
    expect(r.stdout).not.toMatch(/pane closed for w1 \(/); // no false "closed" claim
    expect(r.stderr).toMatch(/still listed|by hand|did not clear/i); // surfaced for the operator
    expect(readFileSync(log, "utf8")).toMatch(/git worktree remove/); // worktree still removed
  });

  it("never claims 'closed' when the verify read is empty/garbled (herdr drift, not an empty roster)", () => {
    // Roster resolves the pane, but `agent list` goes empty right after the close.
    // An empty reply is "unverifiable", never "agent gone" — that misread is the
    // false-success this fix exists to prevent.
    const marker = scratch("drift");
    const herdr = [
      `roster='{"result":{"agents":[{"name":"w1","agent_status":"idle","pane_id":"w1:p1V"}]}}'`,
      `case "$1 $2" in`,
      `  "agent list") if [ -f "${marker}" ]; then printf ''; else printf '%s\\n' "$roster"; fi ;;`,
      `  "pane close") : > "${marker}"; true ;;`,
      `  *) true ;;`,
      `esac`,
    ].join("\n");
    const { log, env } = stubBin({ herdr, git: GIT_OK });
    const r = closeLane(env);
    expect(r.status).toBe(0); // still a terminal path
    expect(r.stdout).not.toMatch(/pane closed for w1/); // must not claim success it can't verify
    expect(r.stderr).toMatch(/unverifiable|could not read|still listed/i);
    expect(readFileSync(log, "utf8")).toMatch(/git worktree remove/);
  });
});

describe("clean-panes.sh shares the pane-close fix (sibling caller)", () => {
  // A lane pane clean-panes recognizes: agent w1 idle, a transcript showing lane
  // activity (/lfg …), and a clean ❯ prompt so the unsent-input guard passes.
  const cleanPanesHerdr = (marker) =>
    [
      `roster='{"result":{"agents":[{"name":"w1","agent_status":"idle","pane_id":"w1:p1V"}]}}'`,
      `gone='{"result":{"agents":[]}}'`,
      `capture=$'running /lfg on the plan\\n│ ❯ Try /help │'`,
      `case "$1 $2" in`,
      `  "agent list") if [ -f "${marker}" ]; then printf '%s\\n' "$gone"; else printf '%s\\n' "$roster"; fi ;;`,
      `  "agent read") printf '%s\\n' "$capture" ;;`,
      `  "pane close") [ "$3" = "w1:p1V" ] && : > "${marker}"; true ;;`,
      `  *) true ;;`,
      `esac`,
    ].join("\n");

  it("closes a stale lane pane by its resolved id, not `--name`", () => {
    const marker = scratch("clean-closed");
    const { log, env } = stubBin({ herdr: cleanPanesHerdr(marker) });
    const r = spawnSync("bash", [CLEAN_PANES], { encoding: "utf8", cwd: SCRATCH, env, timeout: 20_000 });
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toMatch(/herdr pane close w1:p1V/);
    expect(calls).not.toMatch(/pane close --name/);
    expect(r.stdout).toMatch(/closed 1 pane/);
  });
});

describe("check_no_unsent_input marker", () => {
  const check = (capture) => {
    const capFile = scratch("capture.txt");
    writeFileSync(capFile, capture);
    const { env } = stubBin({ herdr: `case "$1 $2" in "agent read") cat "${capFile}" ;; *) true ;; esac` });
    // Call it exactly as close-lane.sh does — inside an `if` condition, which
    // suspends `set -e` in the function body (bash rule) just like production, so
    // a fail-closed grep path reaches its own message instead of dying early.
    const script = scratch("check.sh");
    writeFileSync(script, `set -euo pipefail\n. "${LIB}"\nif check_no_unsent_input w1; then exit 0; else exit 1; fi\n`);
    return spawnSync("bash", [script], { encoding: "utf8", cwd: SCRATCH, env, timeout: 20_000 });
  };

  it("passes a clean pane rendered with the heavy-arrow ❯ prompt and a placeholder hint", () => {
    const r = check(['╭──────────────╮', '│ ❯ Try "run the tests" or /help for shortcuts │', '╰──────────────╯'].join("\n"));
    expect(r.status).toBe(0);
  });

  it("passes a clean pane sitting at a bare ❯ prompt", () => {
    const r = check(["some earlier output", "│ ❯                                    │"].join("\n"));
    expect(r.status).toBe(0);
  });

  it("still refuses a ❯ prompt carrying genuinely typed, unsent text (R26 preserved)", () => {
    const r = check(["│ ❯ deploy the thing now               │"].join("\n"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unsent input detected/);
  });

  it("still fails closed on a non-empty capture with no prompt marker at all", () => {
    const r = check(["transcript output", "with no prompt box line"].join("\n"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no prompt marker/);
  });

  it("keeps working for a legacy ASCII `>` prompt: empty passes, typed refuses", () => {
    expect(check(["│ > Try /help │"].join("\n")).status).toBe(0);
    expect(check(["│ > rm the files │"].join("\n")).status).not.toBe(0);
  });
});
