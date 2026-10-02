import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { CONFIG_FILENAME, DEFAULTS, PmConfigError, loadPmConfig } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.mjs");
const LIB = join(HERE, "lib.sh");
const FIXTURES = join(HERE, "__fixtures__");

// Throwaway configs go to an isolated OS temp dir, never into the repo tree
// (the skill dir is a protected path the mode itself guards). The two
// committed fixtures are read from there too, via a copy into a throwaway root:
// the checkout this file lives in is NOT usable as a `--primary`, because in a
// linked worktree it sits under .claude/worktrees/ and the loader refuses that.
const SCRATCH = mkdtempSync(join(tmpdir(), "pm-config-test-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let seq = 0;
// Make a throwaway "primary" root holding an optional .multi-worker-pm.json. The
// `.git` marker is what makes it a checkout in the loader's eyes — the same probe
// lib.sh's `primary_path` already uses.
const makeRoot = (contents, { git = true } = {}) => {
  const root = join(SCRATCH, `root-${seq++}`);
  mkdirSync(root, { recursive: true });
  if (git) mkdirSync(join(root, ".git"), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(root, CONFIG_FILENAME), typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  }
  return root;
};

// A throwaway primary carrying a copy of one committed fixture, so a --config
// test never has to point at the repo checkout itself.
const rootWithFixture = (name) => {
  const root = makeRoot();
  const path = join(root, name);
  copyFileSync(join(FIXTURES, name), path);
  return { root, path };
};

const load = (argv, env = {}) => loadPmConfig({ argv, env, cwd: SCRATCH });
// Collect the problem list from a load that must fail, so a scenario can assert
// on every named problem at once (the collect-all-problems contract, KTD1).
const problemsOf = (argv, env = {}) => {
  try {
    load(argv, env);
  } catch (e) {
    if (e instanceof PmConfigError) return e.problems.join("\n");
    throw e;
  }
  throw new Error("expected loadPmConfig to throw PmConfigError");
};

const runCli = (args, opts = {}) => spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", cwd: HERE, ...opts });

// --- Neutral defaults (R6) and the scripts that read them ------------------

describe("neutral DEFAULTS (R6)", () => {
  it("no config file → base main, empty required checks, null preview context, push bar, no env files, no identity", () => {
    const { config } = load(["--primary", makeRoot()]);
    expect(config.baseBranch).toBe("main");
    expect(config.checks).toEqual({ required: [], previewContext: null });
    expect(config.postMergeBar.preview.mode).toBe("push");
    expect(config.postMergeBar.chore.mode).toBe("push");
    expect(config.postMergeBar.preview.inputs).toBeUndefined();
    expect(config.workerEnvFiles).toEqual([]);
    expect(config.workerKind).toBe("claude");
    expect("identity" in config).toBe(false);
    expect("protectedBranches" in config).toBe(false);
    expect("denyHook" in config).toBe(false);
  });

  // run.mjs states NO automation login of its own (KTD6) — it reads
  // identity.expectedAuthors, and refuses spine mode without it.
  it("run.mjs reads authors only from identity.expectedAuthors", () => {
    expect(readFileSync(RUN, "utf8")).toMatch(/identity\?*\.expectedAuthors/);
  });

  // dispatch-preview-bar.sh states NO workflow, input or retry marker of its own:
  // every one of them arrives in the plan `run.mjs spine bar` prints (KTD4).
  it("dispatch-preview-bar.sh reads the bar from the plan", () => {
    const src = readFileSync(join(HERE, "dispatch-preview-bar.sh"), "utf8");
    for (const read of [".workflow", ".inputs", ".retryMarker", ".runs", "spine bar --outcome"]) {
      expect(src, `dispatch-preview-bar.sh no longer reads ${read} from the bar plan`).toContain(read);
    }
  });

  it("watch-worker.sh reads workerEnvFiles from the config", () => {
    expect(readFileSync(join(HERE, "watch-worker.sh"), "utf8")).toContain(".workerEnvFiles");
  });

  it("the committed full fixture and config.example.json both load", () => {
    for (const [dir, name] of [[FIXTURES, "pm-config-full.json"], [join(HERE, ".."), "config.example.json"]]) {
      const root = makeRoot();
      const path = join(root, name);
      copyFileSync(join(dir, name), path);
      const { config } = load(["--primary", root, "--config", path]);
      expect(config.identity.expectedAuthors.length).toBeGreaterThan(0);
    }
  });

  it("config.example.json shows every top-level key and a dispatch-mode bar", () => {
    const example = JSON.parse(readFileSync(join(HERE, "..", "config.example.json"), "utf8"));
    for (const k of [...Object.keys(DEFAULTS), "identity", "protectedBranches", "denyHook"]) expect(example, k).toHaveProperty(k);
    expect([example.postMergeBar.preview.mode, example.postMergeBar.chore.mode]).toContain("dispatch");
  });
});

// --- Loading -----------------------------------------------------------------

describe("loadPmConfig with no file", () => {
  it("returns DEFAULTS and reports the defaults source", () => {
    const { config, path, source, line } = load(["--primary", makeRoot()]);
    expect(config).toEqual(DEFAULTS);
    expect(path).toBeNull();
    expect(source).toBe("defaults");
    expect(line).toMatch(/^config: defaults sha256:[0-9a-f]{12}$/);
  });

  it("does not hand back a live reference to DEFAULTS", () => {
    const { config } = load(["--primary", makeRoot()]);
    config.checks.required.push("mutated");
    expect(DEFAULTS.checks.required).toEqual([]);
  });
});

describe("loadPmConfig with a partial file", () => {
  const partial = {
    subjects: {
      preview: { prefixes: ["feat", "fix", "chore"], skipCd: "ignored" },
      chore: { prefixes: ["chore"], skipCd: "ignored" },
    },
  };

  it("replaces the supplied key whole and leaves every other key at its default", () => {
    const { config, source, path, line } = load(["--primary", makeRoot(partial)]);
    expect(config.subjects).toEqual(partial.subjects);
    expect(config.checks).toEqual(DEFAULTS.checks);
    expect(config.identity).toEqual(DEFAULTS.identity);
    expect(config.postMergeBar).toEqual(DEFAULTS.postMergeBar);
    expect(config.workerEnvFiles).toEqual(DEFAULTS.workerEnvFiles);
    expect(source).toBe("file");
    expect(path.endsWith(".multi-worker-pm.json")).toBe(true);
    expect(line).toMatch(/^config: .*\.multi-worker-pm\.json sha256:[0-9a-f]{12}$/);
  });

  it("never merges inside a supplied key — an incomplete kind is an error, not a fill-in", () => {
    const root = makeRoot({ subjects: { preview: { prefixes: ["chore"] }, chore: { prefixes: ["chore"], skipCd: "required" } } });
    expect(problemsOf(["--primary", root])).toMatch(/subjects\.preview\.skipCd/);
  });

  it("digests differ between two different files", () => {
    const a = load(["--primary", makeRoot(partial)]).digest;
    const b = load(["--primary", makeRoot({ ...partial, workerEnvFiles: [] })]).digest;
    expect(a).not.toBe(b);
  });
});

describe("loadPmConfig validation (R3)", () => {
  const cases = [
    ["unknown top-level key", { nope: 1 }, /unknown config key: nope/],
    ["unknown nested key", { checks: { required: ["unit"], previewContext: null, extra: 1 } }, /unknown config key: checks\.extra/],
    ["an aws block", { aws: { stackPrefix: "x-" } }, /unknown config key: aws/],
    ["an aws: null", { aws: null }, /unknown config key: aws/],
    ["an empty renovate.branchPrefixes", { renovate: { branchPrefixes: [] } }, /renovate\.branchPrefixes must not be empty/],
    ["an unknown renovate key", { renovate: { branchPrefixes: ["renovate/"], extra: 1 } }, /unknown config key: renovate\.extra/],
    ["a non-string baseBranch", { baseBranch: 1 }, /baseBranch must be a non-empty string/],
    ["an empty protectedBranches", { protectedBranches: [] }, /protectedBranches must not be empty/],
    ["a non-string in dangerPaths", { dangerPaths: [1] }, /dangerPaths must be an array/],
    ["a non-array protectedPaths", { protectedPaths: "ops/" }, /protectedPaths must be an array/],
    ["an empty workerKind", { workerKind: "" }, /workerKind must be a non-empty string/],
    ["a non-string denyHook", { denyHook: true }, /denyHook must be a non-empty string/],
    ["version other than 1", { version: 2 }, /version must be 1/],
    ["a bad skipCd enum", { subjects: { preview: { prefixes: ["chore"], skipCd: "maybe" }, chore: { prefixes: ["chore"], skipCd: "required" } } }, /subjects\.preview\.skipCd/],
    [
      "push mode with more than one run",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "push", workflow: "ci.yml", runs: 2 } } },
      /postMergeBar\.chore\.runs must be 1 in push mode/,
    ],
    [
      "push mode carrying inputs",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "push", workflow: "ci.yml", runs: 1, inputs: { branch: "main" } } } },
      /postMergeBar\.chore\.inputs/,
    ],
    // push mode's flow (select-push-run.sh + watch-run.sh) has no log scan, so a
    // marker would silently never fire and certify a run that retried into green.
    [
      "push mode carrying a retryMarker",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "push", workflow: "ci.yml", runs: 1, retryMarker: "(Attempt 2 of" } } },
      /postMergeBar\.chore\.retryMarker is not allowed in push mode/,
    ],
    [
      "an unknown bar key",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "dispatch", workflow: "ci.yml", runs: 1, awaitDeployJob: true } } },
      /unknown config key: postMergeBar\.chore\.awaitDeployJob/,
    ],
    ["a checks block without previewContext", { checks: { required: ["unit"] } }, /checks\.previewContext is required/],
    [
      "an input placeholder other than ${sha}",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "dispatch", workflow: "ci.yml", runs: 1, inputs: { ref: "${other}" } } } },
      /postMergeBar\.chore\.inputs\.ref.*\$\{sha\}/s,
    ],
    [
      "a retryMarker carrying regex metacharacters",
      { postMergeBar: { ...DEFAULTS.postMergeBar, chore: { mode: "dispatch", workflow: "ci.yml", runs: 1, retryMarker: "(Attempt [2-9]* of" } } },
      /postMergeBar\.chore\.retryMarker/,
    ],
    ["maxRuns below one", { postMergeBar: { ...DEFAULTS.postMergeBar, maxRuns: 0 } }, /postMergeBar\.maxRuns/],
    ["a non-string in workerEnvFiles", { workerEnvFiles: [1] }, /workerEnvFiles/],
    ["an empty identity list", { identity: { expectedAuthors: [] } }, /identity\.expectedAuthors/],
  ];

  for (const [name, contents, matcher] of cases) {
    it(`names ${name}`, () => {
      expect(problemsOf(["--primary", makeRoot(contents)])).toMatch(matcher);
    });
  }

  it("collects every problem in one report rather than stopping at the first", () => {
    const out = problemsOf(["--primary", makeRoot({ version: 2, nope: 1, workerEnvFiles: "no" })]);
    expect(out).toMatch(/version must be 1/);
    expect(out).toMatch(/unknown config key: nope/);
    expect(out).toMatch(/workerEnvFiles/);
  });

  it("reports both push-mode extras alongside every other problem in one report", () => {
    const out = problemsOf([
      "--primary",
      makeRoot({
        nope: 1,
        postMergeBar: {
          ...DEFAULTS.postMergeBar,
          chore: { mode: "push", workflow: "ci.yml", runs: 2, retryMarker: "(Attempt 2 of" },
        },
      }),
    ]);
    expect(out).toMatch(/unknown config key: nope/);
    expect(out).toMatch(/postMergeBar\.chore\.runs must be 1 in push mode/);
    expect(out).toMatch(/postMergeBar\.chore\.retryMarker is not allowed in push mode/);
  });

  it("accepts an empty checks.required and every new key at a valid value", () => {
    const contents = {
      checks: { required: [], previewContext: null },
      baseBranch: "develop",
      protectedBranches: ["develop", "main"],
      dangerPaths: ["infra/"],
      protectedPaths: ["ops/"],
      workerKind: "codex",
      denyHook: "node hooks/deny.mjs",
    };
    const { config } = load(["--primary", makeRoot(contents)]);
    expect(config).toMatchObject(contents);
  });

  it("names the byte offset in malformed JSON", () => {
    expect(problemsOf(["--primary", makeRoot('{"version":1,}')])).toMatch(/position \d+/);
  });
});

describe("loadPmConfig hostile keys", () => {
  it("rejects __proto__ and constructor without touching Object.prototype", () => {
    const raw = '{"version":1,"__proto__":{"polluted":true},"constructor":{"polluted":true}}';
    const out = problemsOf(["--primary", makeRoot(raw)]);
    expect(out).toMatch(/__proto__/);
    expect(out).toMatch(/constructor/);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it("ignores the _meta provenance note", () => {
    const { config } = load(["--primary", makeRoot({ _meta: { note: "copied from config.example.json" } })]);
    expect(config).toEqual(DEFAULTS);
  });
});

describe("loadPmConfig path resolution (KTD3)", () => {
  it("accepts --config under the primary", () => {
    const fixture = rootWithFixture("pm-config-consumer.json");
    const { config, path } = load(["--primary", fixture.root, "--config", fixture.path]);
    expect(path).toBe(fixture.path);
    expect(config.postMergeBar.preview.mode).toBe("push");
  });

  it("refuses a --config outside the primary with config-outside-primary", () => {
    const outside = join(makeRoot(), "elsewhere.json");
    writeFileSync(outside, "{}");
    expect(problemsOf(["--primary", makeRoot(), "--config", outside])).toMatch(/config-outside-primary/);
  });

  // The root is a control too: pointing --primary at a lane's worktree would make
  // the lane's OWN config authoritative, which is the guarantee KTD3 states.
  const laneWorktree = () => {
    const lane = join(makeRoot(), ".claude", "worktrees", "lane");
    mkdirSync(join(lane, ".git"), { recursive: true });
    writeFileSync(join(lane, CONFIG_FILENAME), JSON.stringify({ workerEnvFiles: ["lane-authored"] }));
    return lane;
  };

  it("refuses a --primary inside .claude/worktrees/ with primary-inside-worktree", () => {
    expect(problemsOf(["--primary", laneWorktree()])).toMatch(/primary-inside-worktree/);
  });

  it("refuses a SPINE_PRIMARY inside .claude/worktrees/ the same way", () => {
    expect(problemsOf([], { SPINE_PRIMARY: laneWorktree() })).toMatch(/primary-inside-worktree/);
  });

  it("refuses a --primary that is not a git checkout with primary-not-a-checkout", () => {
    expect(problemsOf(["--primary", makeRoot(undefined, { git: false })])).toMatch(/primary-not-a-checkout/);
  });

  it("still loads a config sitting in a valid primary root", () => {
    const { config, source } = load(["--primary", makeRoot({ workerEnvFiles: ["primary-copy"] })]);
    expect(config.workerEnvFiles).toEqual(["primary-copy"]);
    expect(source).toBe("file");
  });

  // An ABSENT root is not the same as a SUPPLIED-but-invalid one: with no flag,
  // no env and no git checkout to discover there is simply no primary, and the
  // documented fallback is DEFAULTS — never an error.
  it("returns DEFAULTS when discovery finds no git root at all", () => {
    const { config, root, source } = loadPmConfig({ argv: [], env: {}, cwd: SCRATCH });
    expect(config).toEqual(DEFAULTS);
    expect(root).toBeNull();
    expect(source).toBe("defaults");
  });

  it("refuses a --config under .claude/worktrees/ even though it sits inside the primary", () => {
    const root = makeRoot();
    const wt = join(root, ".claude", "worktrees", "lane");
    mkdirSync(wt, { recursive: true });
    const planted = join(wt, ".multi-worker-pm.json");
    writeFileSync(planted, "{}");
    expect(problemsOf(["--primary", root, "--config", planted])).toMatch(/config-outside-primary/);
  });

  it("prefers --primary over SPINE_PRIMARY, and SPINE_PRIMARY over discovery", () => {
    const flagged = makeRoot({ workerEnvFiles: ["from-flag"] });
    const env = makeRoot({ workerEnvFiles: ["from-env"] });
    expect(load(["--primary", flagged], { SPINE_PRIMARY: env }).config.workerEnvFiles).toEqual(["from-flag"]);
    expect(load([], { SPINE_PRIMARY: env }).config.workerEnvFiles).toEqual(["from-env"]);
  });

  it("resolves the primary's file from a cwd inside a worktree, never the worktree's own copy", () => {
    const root = makeRoot({ workerEnvFiles: ["primary-copy"] });
    const wt = join(root, ".claude", "worktrees", "lane");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".multi-worker-pm.json"), JSON.stringify({ workerEnvFiles: ["lane-copy"] }));
    const { config } = loadPmConfig({ argv: ["--primary", root], env: {}, cwd: wt });
    expect(config.workerEnvFiles).toEqual(["primary-copy"]);
  });
});

// --- Entrypoint wiring -------------------------------------------------------

describe("run.mjs spine config", () => {
  it("prints the validated object on stdout and the digest line on stderr", () => {
    const root = makeRoot();
    const r = runCli(["spine", "config", "--primary", root]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(DEFAULTS);
    expect(r.stderr.trim().split("\n")[0]).toMatch(/^config: defaults sha256:[0-9a-f]{12}$/);
  });

  it("exits 2 with no stdout on an unknown key", () => {
    const r = runCli(["spine", "config", "--primary", makeRoot({ nope: 1 })]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/unknown config key: nope/);
  });

  it("refuses every subcommand on a bad config before anything else runs", () => {
    const r = runCli(["spine", "status", "1", "--dry-run", "--primary", makeRoot({ version: 2 })], {
      env: { ...process.env, PATH: "" },
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/version must be 1/);
  });

  it("prints the digest line first on stderr for spine status", () => {
    const r = runCli(["spine", "status", "--snapshot", join(FIXTURES, "spine-epic.json"), "--dry-run", "--primary", makeRoot()], {
      env: { ...process.env, PATH: "" },
    });
    expect(r.stderr.trim().split("\n")[0]).toMatch(/^config: defaults sha256:[0-9a-f]{12}$/);
  });
});

describe("pm_cfg (lib.sh)", () => {
  const shell = (body) => {
    const script = join(SCRATCH, `shell-${seq++}.sh`);
    writeFileSync(script, `set -euo pipefail\n. "${LIB}"\n${body}\n`);
    return spawnSync("bash", [script], { encoding: "utf8", cwd: HERE });
  };

  it("pipes a jq path through spine config", () => {
    const r = shell(`pm_cfg '.postMergeBar.preview.workflow' --primary "${makeRoot()}"`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(DEFAULTS.postMergeBar.preview.workflow);
  });

  it("inherits the loader's refusal and prints nothing", () => {
    const r = shell(`pm_cfg '.version' --primary "${makeRoot({ nope: 1 })}"`);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/unknown config key: nope/);
  });

  it("prints the digest line once per script when the script preloads", () => {
    const root = makeRoot();
    const r = shell(`pm_cfg_load --primary "${root}"\npm_cfg '.version'\npm_cfg '.postMergeBar.maxRuns'`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1", String(DEFAULTS.postMergeBar.maxRuns)]);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("config: ")).length).toBe(1);
  });
});
