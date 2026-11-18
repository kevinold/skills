import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../../skills/ko-acceptance-validator/scripts/nudge.mjs";

const SCRIPTS = resolve(import.meta.dirname, "../../skills/ko-acceptance-validator/scripts");
const NUDGE = join(SCRIPTS, "nudge.mjs");
const WIRE = join(SCRIPTS, "wire-hooks.mjs");
const env = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), ...extra });

describe("classify", () => {
  it.each([
    ["write", "docs/plans/reorder-plan.md"],
    ["Write", "/repo/docs/plans/reorder-plan.md"],
    ["edit", "plans/a.md"],
    ["MultiEdit", "docs/plans/a.md"],
  ])("%s on %s is a plan event", (tool, path) => {
    expect(classify({ tool, path })).toBe("plan");
  });

  it.each([
    ["write", "docs/plans/README.md"],
    ["write", "docs/plans/a.feature"],
    ["write", "src/plans.md"],
    ["read", "docs/plans/a.md"],
    ["write", undefined],
  ])("%s on %s is nothing", (tool, path) => {
    expect(classify({ tool, path })).toBeNull();
  });

  it.each(["gh pr create --fill", "git push -u origin x", "cd a && git push"])("%s is a build event", (command) => {
    expect(classify({ tool: "bash", command })).toBe("build");
  });

  it.each(["git status", "echo gh pr view", "npm test"])("%s is nothing", (command) => {
    expect(classify({ tool: "bash", command })).toBeNull();
  });

  it("a project can name its own build triggers, matched against commands and skills", () => {
    expect(classify({ tool: "Skill", skill: "acme:browser-check" }, { buildOn: "browser-check" })).toBe("build");
    expect(classify({ tool: "bash", command: "git push" }, { buildOn: "browser-check" })).toBeNull();
  });

  it("an unreadable build trigger falls back to the default rather than throwing", () => {
    expect(classify({ tool: "bash", command: "git push" }, { buildOn: "(" })).toBe("build");
  });
});

describe("the nudge CLI", () => {
  let repo;
  const PLAN = "docs/plans/reorder-plan.md";
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: env() }).trim();
  const cli = (args, input) => spawnSync(process.execPath, [NUDGE, ...args], { cwd: repo, encoding: "utf8", env: env(), input });
  const event = (...args) => cli(["event", ...args]);
  const specVerdict = (feature, name = "spec-abc1234-h-f.json") => {
    mkdirSync(join(repo, ".tmp/acceptance"), { recursive: true });
    writeFileSync(join(repo, ".tmp/acceptance", name), JSON.stringify({ stage: "spec", artifact_path: feature }));
    return join(repo, ".tmp/acceptance", name);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "acceptance-nudge-"));
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    mkdirSync(join(repo, "docs/plans"), { recursive: true });
    writeFileSync(join(repo, PLAN), "# Plan\n");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reminds on a plan with no spec verdict, naming the plan and saying it is advisory", () => {
    const r = event("--tool", "write", "--path", PLAN);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(PLAN);
    expect(r.stdout).toContain("spec");
    expect(r.stdout).toMatch(/advisory/i);
  });

  it("needs no readiness field in the plan's frontmatter", () => {
    writeFileSync(join(repo, PLAN), "---\ntitle: x\n---\n# Plan\n");
    expect(event("--tool", "write", "--path", PLAN).stdout).not.toBe("");
  });

  it("goes quiet once a spec verdict for this plan is newer than the plan", () => {
    specVerdict("docs/plans/reorder-plan.feature");
    expect(event("--tool", "write", "--path", PLAN).stdout).toBe("");
  });

  it("reminds again when the plan is edited after its verdict", () => {
    const v = specVerdict("docs/plans/reorder-plan.feature");
    utimesSync(v, 1000, 1000);
    expect(event("--tool", "edit", "--path", PLAN).stdout).not.toBe("");
  });

  it("is not silenced by a verdict for a different plan", () => {
    specVerdict("docs/plans/other-plan.feature");
    expect(event("--tool", "write", "--path", PLAN).stdout).not.toBe("");
  });

  it("stays silent on a build event in a checkout that never ran the spec stage", () => {
    expect(event("--tool", "bash", "--command", "git push").stdout).toBe("");
  });

  it("reminds on a build event until the verdict for HEAD is posted", () => {
    specVerdict("docs/plans/reorder-plan.feature");
    const r = event("--tool", "bash", "--command", "git push");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("build");
    writeFileSync(join(repo, `.tmp/acceptance/posted-${git("rev-parse", "HEAD").slice(0, 7)}.json`), "{}");
    expect(event("--tool", "bash", "--command", "git push").stdout).toBe("");
  });

  it("honors --build-on", () => {
    specVerdict("docs/plans/reorder-plan.feature");
    expect(event("--tool", "Skill", "--skill", "browser-check", "--build-on", "browser-check").stdout).toContain("build");
  });

  it("stays silent and exits 0 outside a git checkout and on bad input", () => {
    const bare = mkdtempSync(join(tmpdir(), "acceptance-nudge-bare-"));
    mkdirSync(join(bare, ".tmp/acceptance"), { recursive: true });
    writeFileSync(join(bare, ".tmp/acceptance/spec-a.json"), "{}");
    const r = spawnSync(process.execPath, [NUDGE, "event", "--tool", "bash", "--command", "git push"], { cwd: bare, encoding: "utf8", env: env() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    rmSync(bare, { recursive: true, force: true });
    expect(cli(["event", "--nonsense"]).status).toBe(0);
    expect(cli([]).status).toBe(0);
    expect(cli(["claude-code"], "not json").status).toBe(0);
  });

  it("speaks the Claude Code hook protocol", () => {
    const r = cli(["claude-code"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(repo, PLAN) } }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("spec");
  });

  it("reads Bash commands and Skill names from a Claude Code payload", () => {
    specVerdict("docs/plans/reorder-plan.feature");
    const bash = cli(["claude-code"], JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" } }));
    expect(JSON.parse(bash.stdout).hookSpecificOutput.additionalContext).toContain("build");
    const skill = cli(["claude-code", "--build-on", "browser-check"], JSON.stringify({ tool_name: "Skill", tool_input: { skill: "x:browser-check" } }));
    expect(JSON.parse(skill.stdout).hookSpecificOutput.additionalContext).toContain("build");
  });

  it("prints nothing in the Claude Code protocol when there is nothing to say", () => {
    expect(cli(["claude-code"], JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(repo, PLAN) } })).stdout).toBe("");
  });
});

describe("wire-hooks", () => {
  let project;
  let home;
  let wire;

  // An installed copy, as a project-level install lands it.
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "acceptance-wire-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "acceptance-wire-home-")));
    cpSync(SCRIPTS, join(project, ".agents/skills/ko-acceptance-validator/scripts"), { recursive: true });
    wire = join(project, ".agents/skills/ko-acceptance-validator/scripts/wire-hooks.mjs");
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const run = (...args) => spawnSync(process.execPath, [wire, ...args], { cwd: project, encoding: "utf8", env: env({ HOME: home }) });
  const settingsPath = () => join(project, ".claude/settings.json");
  const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
  const OMP_HOOK = () => join(project, ".omp/hooks/post/acceptance-nudge.ts");

  it("needs a harness it knows", () => {
    expect(run("nonsense").status).toBe(2);
    expect(run().status).toBe(2);
  });

  it("adds a Claude Code hook using a project-relative path", () => {
    expect(run("claude-code").status).toBe(0);
    const entries = settings().hooks.PostToolUse;
    expect(entries.map((e) => e.matcher)).toEqual(["Write|Edit|MultiEdit|Bash|Skill"]);
    expect(entries[0].hooks[0].command).toBe('node "${CLAUDE_PROJECT_DIR:-.}/.agents/skills/ko-acceptance-validator/scripts/nudge.mjs" claude-code');
  });

  it("keeps existing settings and hooks", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), JSON.stringify({ model: "x", hooks: { PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "keep" }] }], Stop: [] } }));
    run("claude-code");
    const s = settings();
    expect(s.model).toBe("x");
    expect(s.hooks.Stop).toEqual([]);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe("keep");
    expect(s.hooks.PostToolUse).toHaveLength(2);
  });

  it("is idempotent", () => {
    run("claude-code");
    run("claude-code");
    expect(settings().hooks.PostToolUse).toHaveLength(1);
  });

  it("replaces its own entry when the build trigger changes", () => {
    run("claude-code");
    run("claude-code", "--build-on", "browser-check");
    const entries = settings().hooks.PostToolUse;
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain("--build-on 'browser-check'");
  });

  it("refuses a build trigger that could break out of the quoted command", () => {
    expect(run("claude-code", "--build-on", "a'; rm -rf x; '").status).toBe(2);
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("refuses to overwrite settings it cannot parse", () => {
    mkdirSync(join(project, ".claude"));
    writeFileSync(settingsPath(), "{ not json");
    const r = run("claude-code");
    expect(r.status).toBe(1);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{ not json");
  });

  it("writes to user settings with --global, using an absolute path", () => {
    expect(run("claude-code", "--global").status).toBe(0);
    const s = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    expect(s.hooks.PostToolUse[0].hooks[0].command).toContain(join(project, ".agents/skills"));
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("--dry-run changes nothing and says what it would write", () => {
    const r = run("omp", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("acceptance-nudge.ts");
    expect(existsSync(OMP_HOOK())).toBe(false);
  });

  it("writes an omp hook module that omp discovers by location", () => {
    expect(run("omp").status).toBe(0);
    expect(existsSync(OMP_HOOK())).toBe(true);
    expect(run("omp", "--global").status).toBe(0);
    expect(existsSync(join(home, ".omp/agent/hooks/post/acceptance-nudge.ts"))).toBe(true);
  });

  describe("the generated omp hook", () => {
    const load = async (...args) => {
      run("omp", ...args);
      const { default: register } = await import(`${OMP_HOOK()}?t=${args.join("")}`);
      const handlers = {};
      const calls = [];
      register({
        on: (name, fn) => (handlers[name] = fn),
        exec: async (cmd, argv) => {
          calls.push([cmd, argv]);
          return { stdout: "remember the spec\n", code: 0 };
        },
      });
      return { handler: handlers.tool_result, calls };
    };

    it("passes a write's path to the nudge and returns its text as additional context", async () => {
      const { handler, calls } = await load();
      const result = await handler({ toolName: "write", input: { path: "docs/plans/a.md" }, isError: false });
      expect(result).toEqual({ additionalContext: "remember the spec" });
      expect(calls[0][0]).toBe("node");
      expect(calls[0][1][0]).toBe(join(project, ".agents/skills/ko-acceptance-validator/scripts/nudge.mjs"));
      expect(calls[0][1].slice(1)).toEqual(["event", "--tool", "write", "--path", "docs/plans/a.md"]);
    });

    it("passes a bash command", async () => {
      const { handler, calls } = await load();
      await handler({ toolName: "bash", input: { command: "git push" }, isError: false });
      expect(calls[0][1].slice(1)).toEqual(["event", "--tool", "bash", "--command", "git push"]);
    });

    it("carries the build trigger", async () => {
      const { handler, calls } = await load("--build-on", "browser-check");
      await handler({ toolName: "bash", input: { command: "x" }, isError: false });
      expect(calls[0][1].slice(-2)).toEqual(["--build-on", "browser-check"]);
    });

    it("ignores failed tools and tools it has no use for, spawning nothing", async () => {
      const { handler, calls } = await load();
      expect(await handler({ toolName: "write", input: { path: "a" }, isError: true })).toBeUndefined();
      expect(await handler({ toolName: "read", input: { path: "a" }, isError: false })).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("returns nothing when the nudge has nothing to say or cannot run", async () => {
      run("omp");
      const { default: register } = await import(`${OMP_HOOK()}?t=quiet`);
      let handler;
      let exec = async () => ({ stdout: "" });
      register({ on: (_, fn) => (handler = fn), exec: (...a) => exec(...a) });
      expect(await handler({ toolName: "write", input: { path: "a" }, isError: false })).toBeUndefined();
      exec = async () => {
        throw new Error("no node");
      };
      expect(await handler({ toolName: "write", input: { path: "a" }, isError: false })).toBeUndefined();
    });
  });
});
