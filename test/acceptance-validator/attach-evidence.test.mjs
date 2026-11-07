import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  selectEvidence,
  composeComment,
  resolveTarget,
  ghArgs,
  postedMarkerPath,
  run,
} from "../../skills/ko-acceptance-validator/scripts/attach-evidence.mjs";
import { isRemoteTarget } from "../../skills/ko-acceptance-validator/scripts/verdict.mjs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Git hooks export GIT_DIR and friends; a scratch repo must not inherit them.
const gitFreeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

const SHA7 = "abc1234";
const GENERATED_AT = "2026-09-16T09:00:00.000Z";

// Build a schema-valid build verdict. `evidence` maps dimension name -> path list.
function buildVerdict(evidence, { verdict = "PASS", reason, statuses = {} } = {}) {
  const dims = {};
  for (const name of ["workflow-fit", "legibility", "intent-match", "convention-fit"]) {
    dims[name] = {
      status: statuses[name] ?? "PASS",
      findings: [`${name} reads fine to me.`],
      evidence: evidence[name] ?? [],
    };
  }
  const v = {
    schema: "acceptance-verdict/v1",
    stage: "build",
    sha: SHA7 + "def",
    artifact_hash: "hash123deadbeef",
    artifact_path: "docs/plans/x.feature",
    target_url: "http://localhost:5173",
    judge_fingerprint: "model-x@abc",
    dimensions: dims,
    routes: [{ route: "/orders", result: "Pass", reason: "" }],
    scenarios: [{ id: "s1", kind: "good", dimension: "workflow-fit", route: "/orders", status: "held" }],
    generated_at: GENERATED_AT,
    verdict,
  };
  if (verdict === "unevaluated") v.reason = reason ?? "dimension legibility unevaluated";
  return v;
}

const existsAll = () => true;

describe("selectEvidence", () => {
  it("unions dimension evidence, dedupes in first-seen order, existence-checks", () => {
    const v = buildVerdict({
      "workflow-fit": ["a.png", "b.png"],
      legibility: ["b.png", "c.png"], // b duplicated
      "intent-match": ["d.png"],
      "convention-fit": [],
    });
    const sel = selectEvidence(v, existsAll);
    expect(sel.files).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(sel.omitted).toBe(0);
    expect(sel.missing).toBe(0);
  });

  it("excludes missing files and reports the count", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png", "gone.png"], legibility: ["c.png"] });
    const exists = (p) => p !== "gone.png";
    const sel = selectEvidence(v, exists);
    expect(sel.files).toEqual(["a.png", "c.png"]);
    expect(sel.missing).toBe(1);
    expect(sel.omitted).toBe(0);
  });

  it("caps existing files at 50 and reports the truncation count", () => {
    const many = Array.from({ length: 55 }, (_, i) => `s${i}.png`);
    // 5 of them duplicated across a second dimension -> still 55 unique here
    const v = buildVerdict({ "workflow-fit": many, legibility: many.slice(0, 5) });
    const sel = selectEvidence(v, existsAll);
    expect(sel.files.length).toBe(50);
    expect(sel.omitted).toBe(5);
    expect(sel.missing).toBe(0);
  });
});

describe("composeComment", () => {
  it("renders the verdict line, route table, four dimensions, and one image per attached file", () => {
    const v = buildVerdict({
      "workflow-fit": ["a.png"],
      legibility: ["b.png"],
      "intent-match": ["c.png"],
      "convention-fit": ["d.png"],
    });
    const sel = selectEvidence(v, existsAll);
    const body = composeComment(v, sel, {});
    expect(body).toContain("### Acceptance verdict: **PASS** (advisory)");
    expect(body).toContain("/orders"); // route table
    for (const label of ["Workflow-fit", "Legibility", "Intent-match", "Convention-fit"]) {
      expect(body).toContain(label);
    }
    const refs = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(body).toContain(GENERATED_AT);
  });

  it("R2 invariant: body image refs never point outside the attached set (cap case)", () => {
    const many = Array.from({ length: 60 }, (_, i) => `s${i}.png`);
    const v = buildVerdict({ "workflow-fit": many });
    const sel = selectEvidence(v, existsAll);
    const body = composeComment(v, sel, {});
    const refs = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(refs.length).toBe(50);
    for (const r of refs) expect(sel.files).toContain(r);
    expect(body).toMatch(/10 (screenshot|image|evidence)/i); // 60 - 50 omitted stated
  });

  it("missing file produces no broken image reference", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png", "gone.png"] });
    const sel = selectEvidence(v, (p) => p !== "gone.png");
    const body = composeComment(v, sel, {});
    expect(body).not.toContain("gone.png");
    expect(body).toContain("a.png");
    expect(body).toMatch(/1 (screenshot|image|evidence).*(missing|not found)/i);
  });

  it("unevaluated verdict states its reason honestly", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] }, { verdict: "unevaluated", reason: "dimension legibility unevaluated", statuses: { legibility: "unevaluated" } });
    const sel = selectEvidence(v, existsAll);
    const body = composeComment(v, sel, {});
    expect(body).toContain("**unevaluated** (advisory)");
    expect(body).toContain("dimension legibility unevaluated");
  });

  it("appends the trailer verbatim", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    const sel = selectEvidence(v, existsAll);
    const body = composeComment(v, sel, { trailer: "https://claude.ai/code/session_X" });
    expect(body.trimEnd().endsWith("https://claude.ai/code/session_X")).toBe(true);
  });

  it("is deterministic for identical inputs (uses stored generated_at, not the clock)", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    const sel = selectEvidence(v, existsAll);
    expect(composeComment(v, sel, {})).toBe(composeComment(v, sel, {}));
  });

  it("omits the route table when routes is empty", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    v.routes = [];
    const body = composeComment(v, selectEvidence(v, existsAll), {});
    expect(body).not.toContain("| Route | Result | Notes |");
  });

  it("omits a dimension heading when that dimension key is absent", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    delete v.dimensions.legibility;
    const body = composeComment(v, selectEvidence(v, existsAll), {});
    expect(body).not.toContain("Legibility");
    expect(body).toContain("Workflow-fit");
  });

  it("renders a screenshot shared by two dimensions exactly once (1:1 with its single --attach)", () => {
    const v = buildVerdict({ "workflow-fit": ["shared.png"], legibility: ["shared.png"] });
    const sel = selectEvidence(v, existsAll);
    expect(sel.files).toEqual(["shared.png"]); // one --attach
    const body = composeComment(v, sel, {});
    const refs = [...body.matchAll(/!\[[^\]]*\]\(shared\.png\)/g)];
    expect(refs.length).toBe(1);
  });
});

describe("resolveTarget", () => {
  it("prefers the PR when a number is present", () => {
    expect(resolveTarget({ prNumber: 42, branch: "chore-2105-reorder-flow" })).toEqual({ kind: "pr", number: 42 });
  });
  it("falls back to the issue number parsed from the branch name", () => {
    expect(resolveTarget({ prNumber: null, branch: "chore-2105-reorder-flow" })).toEqual({ kind: "issue", number: 2105 });
    expect(resolveTarget({ prNumber: null, branch: "fix-90-login" })).toEqual({ kind: "issue", number: 90 });
  });
  it("returns null when there is no PR and no issue number in the branch", () => {
    expect(resolveTarget({ prNumber: null, branch: "staging" })).toBeNull();
    expect(resolveTarget({ prNumber: null, branch: "chore-notes-2026-08-19" })).toBeNull();
  });
});

describe("ghArgs", () => {
  it("builds pr/issue comment argv with one --attach per file and matching alt", () => {
    const args = ghArgs({ kind: "pr", number: 42 }, "/tmp/body.md", ["dir/a.png", "dir/b.png"]);
    expect(args).toEqual([
      "pr", "comment", "42", "--body-file", "/tmp/body.md",
      "--attach", "dir/a.png#a",
      "--attach", "dir/b.png#b",
    ]);
  });
});

describe("run", () => {
  function deps(overrides = {}) {
    const gh = vi.fn(() => "");
    const writeMarker = vi.fn();
    const writeBody = vi.fn(() => "/tmp/body.md");
    return {
      gh,
      writeMarker,
      writeBody,
      calls: { gh, writeMarker, writeBody },
      headSha7: () => SHA7,
      findVerdict: () => ({ path: `build-${SHA7}-h-f.json`, verdict: buildVerdict({ "workflow-fit": ["a.png"] }) }),
      exists: existsAll,
      readText: () => "",
      alreadyPosted: () => false,
      prNumber: () => 42,
      branch: () => "chore-2105-reorder-flow",
      ...overrides,
    };
  }

  it("posts once and writes a publication marker on success", () => {
    const d = deps();
    const r = run(d, {});
    expect(r.posted).toBe(true);
    expect(d.calls.gh).toHaveBeenCalledTimes(1);
    expect(d.calls.gh.mock.calls[0][0][0]).toBe("pr");
    expect(d.calls.writeMarker).toHaveBeenCalledTimes(1);
  });

  it("no build verdict for HEAD -> no gh call, no marker, note, posted false", () => {
    const d = deps({ findVerdict: () => null });
    const r = run(d, {});
    expect(r.posted).toBe(false);
    expect(r.note).toMatch(/no build verdict/i);
    expect(d.calls.gh).not.toHaveBeenCalled();
    expect(d.calls.writeMarker).not.toHaveBeenCalled();
  });

  it("no PR and unparsable issue -> no gh call, no marker", () => {
    const d = deps({ prNumber: () => null, branch: () => "staging" });
    const r = run(d, {});
    expect(r.posted).toBe(false);
    expect(d.calls.gh).not.toHaveBeenCalled();
    expect(d.calls.writeMarker).not.toHaveBeenCalled();
  });

  it("falls back to an issue comment when no PR exists", () => {
    const d = deps({ prNumber: () => null });
    const r = run(d, {});
    expect(r.posted).toBe(true);
    expect(d.calls.gh.mock.calls[0][0][0]).toBe("issue");
    expect(d.calls.gh.mock.calls[0][0][2]).toBe("2105");
  });

  it("gh failure is caught: posted false, no marker, no throw", () => {
    const d = deps({ gh: vi.fn(() => { throw new Error("gh boom"); }) });
    let r;
    expect(() => { r = run(d, {}); }).not.toThrow();
    expect(r.posted).toBe(false);
    expect(r.note).toMatch(/gh boom|failed/i);
    expect(d.calls.writeMarker).not.toHaveBeenCalled();
  });

  it("is idempotent: skips the post when a marker records this verdict+target+evidence", () => {
    const d = deps({ alreadyPosted: (verdictPath) => verdictPath === `build-${SHA7}-h-f.json` });
    const r = run(d, {});
    expect(r.posted).toBe(false);
    expect(r.note).toMatch(/already posted/i);
    expect(d.calls.gh).not.toHaveBeenCalled();
  });

  it("no HEAD sha -> no gh call, no marker, note, posted false", () => {
    const d = deps({ headSha7: () => null });
    const r = run(d, {});
    expect(r.posted).toBe(false);
    expect(r.note).toMatch(/no HEAD sha/i);
    expect(d.calls.gh).not.toHaveBeenCalled();
    expect(d.calls.writeMarker).not.toHaveBeenCalled();
  });

  it("invalid verdict -> no gh call, note names the errors", () => {
    const bad = { stage: "build", verdict: "PASS" }; // missing required fields
    const d = deps({ findVerdict: () => ({ path: "build-x.json", verdict: bad }) });
    const r = run(d, {});
    expect(r.posted).toBe(false);
    expect(d.calls.gh).not.toHaveBeenCalled();
    expect(r.note).toMatch(/invalid/i);
  });

  it("dry-run composes and resolves a target but never calls gh or writes a marker", () => {
    const d = deps();
    const r = run(d, { dryRun: true });
    expect(d.calls.gh).not.toHaveBeenCalled();
    expect(d.calls.writeMarker).not.toHaveBeenCalled();
    expect(r.note).toMatch(/dry.?run/i);
  });
});

describe("review posture (remote target, --pr, --notes-file)", () => {
  const PREVIEW = "https://feat-2532.preview.example";
  const remote = (extra = {}) => ({ ...buildVerdict({ "workflow-fit": ["a.png"] }), target_url: PREVIEW, ...extra });

  it("classifies localhost forms as local and anything else as remote", () => {
    for (const u of ["http://localhost:5173", "localhost:5177", "http://127.0.0.1:5174/x", null, undefined]) {
      expect(isRemoteTarget(u)).toBe(false);
    }
    expect(isRemoteTarget("https://x.preview.example")).toBe(true);
    expect(isRemoteTarget("https://localhost.evil.example")).toBe(true);
  });

  it("first line names the deployed preview for a remote target_url", () => {
    const v = remote({ evidence_redacted: true });
    const first = composeComment(v, selectEvidence(v, existsAll), {}).split("\n")[0];
    expect(first).toContain("deployed preview");
    expect(first).toContain(PREVIEW);
    expect(first).not.toContain("local app");
  });

  it("first line names the local app for localhost:5177", () => {
    const v = { ...buildVerdict({ "workflow-fit": ["a.png"] }), target_url: "localhost:5177" };
    const first = composeComment(v, selectEvidence(v, existsAll), {}).split("\n")[0];
    expect(first).toContain("local app");
    expect(first).not.toContain("deployed preview");
  });

  it("a verdict with no target never claims an app was driven", () => {
    const v = { ...buildVerdict({}, { verdict: "unevaluated", reason: "missing-judge" }), target_url: null, routes: [] };
    expect(composeComment(v, selectEvidence(v, existsAll), {}).split("\n")[0]).toBe("No app was driven for this verdict.");
  });

  it("a remote comment states that evidence is redacted because a target can show real data", () => {
    const v = remote({ evidence_redacted: true });
    const body = composeComment(v, selectEvidence(v, existsAll), {});
    expect(body).toMatch(/evidence is redacted because a deployed target can show real data/i);
  });

  it("renders reviewer notes under #### Reviewer notes before the Judged line; marker heading unchanged", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    const notes = "- claim A: verified\n- head SHA abc1234 · target local";
    const body = composeComment(v, selectEvidence(v, existsAll), { notes, trailer: "review-lane · w2570" });
    const iNotes = body.indexOf("#### Reviewer notes");
    const iJudged = body.indexOf("_Judged ");
    expect(iNotes).toBeGreaterThan(-1);
    expect(iNotes).toBeLessThan(iJudged);
    expect(body.slice(iNotes, iJudged)).toContain("- claim A: verified");
    expect(body).toContain("### Acceptance verdict: **PASS** (advisory)");
    expect(body.trimEnd().endsWith("review-lane · w2570")).toBe(true);
  });

  it("no notes -> no Reviewer notes section (existing output unchanged)", () => {
    const v = buildVerdict({ "workflow-fit": ["a.png"] });
    expect(composeComment(v, selectEvidence(v, existsAll), {})).not.toContain("Reviewer notes");
  });

  it("resolveTarget({prNumber: 42}) wins over a pr-42 branch", () => {
    expect(resolveTarget({ prNumber: 42, branch: "pr-42" })).toEqual({ kind: "pr", number: 42 });
  });

  function deps(overrides = {}) {
    const gh = vi.fn(() => "");
    const writeMarker = vi.fn();
    return {
      gh,
      writeMarker,
      writeBody: vi.fn(() => "/tmp/body.md"),
      headSha7: () => SHA7,
      findVerdict: () => ({ path: `build-${SHA7}-h-f.json`, verdict: remote() }),
      exists: existsAll,
      readText: () => "",
      alreadyPosted: () => false,
      prNumber: vi.fn(() => 99),
      branch: () => "chore-2105-reorder-flow",
      ...overrides,
    };
  }

  it("explicit --pr posts to that PR without consulting branch PR lookup", () => {
    const d = deps({ findVerdict: () => ({ path: `build-${SHA7}-h-f.json`, verdict: remote({ evidence_redacted: true }) }) });
    const r = run(d, { pr: 2570 });
    expect(r.posted).toBe(true);
    expect(d.gh.mock.calls[0][0].slice(0, 3)).toEqual(["pr", "comment", "2570"]);
    expect(d.prNumber).not.toHaveBeenCalled();
  });

  it("refuses a remote-target verdict whose evidence is not marked redacted (no post, even in dry-run)", () => {
    for (const dryRun of [false, true]) {
      const d = deps();
      const r = run(d, { pr: 2570, dryRun });
      expect(r.posted).toBe(false);
      expect(r.body).toBeUndefined();
      expect(r.note).toMatch(/redact/i);
      expect(d.gh).not.toHaveBeenCalled();
      expect(d.writeMarker).not.toHaveBeenCalled();
    }
  });

  it("a remote verdict with no screenshots (e.g. spec insufficient-intent) still composes one postable comment", () => {
    const v = {
      ...remote(),
      artifact_hash: null,
      verdict: "unevaluated",
      reason: "insufficient-intent: no closing issue",
      routes: [],
      scenarios: [],
    };
    for (const k of Object.keys(v.dimensions)) v.dimensions[k] = { status: "unevaluated", findings: [], evidence: [] };
    const d = deps({ findVerdict: () => ({ path: `build-${SHA7}-noartf-f.json`, verdict: v }) });
    const r = run(d, { pr: 2570, notes: "- not checkable: no intent" });
    expect(r.posted).toBe(true);
    expect(r.body).toContain("**unevaluated** (advisory)");
    expect(r.body).toContain("insufficient-intent");
    expect(r.body).toContain("#### Reviewer notes");
  });
});

describe("CLI --dry-run --pr --notes-file (scratch repo, never posts)", () => {
  const SCRIPT = join(import.meta.dirname, "../../skills/ko-acceptance-validator/scripts/attach-evidence.mjs");
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-evidence-cli-"));
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: gitFreeEnv() });
    g("init", "-q");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(verdictOverrides) {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: gitFreeEnv() }).trim();
    const vdir = join(dir, ".tmp/acceptance");
    mkdirSync(vdir, { recursive: true });
    const v = { ...buildVerdict({ "workflow-fit": [] }), sha, ...verdictOverrides };
    writeFileSync(join(vdir, `build-${sha.slice(0, 7)}-hash123-fp00000.json`), JSON.stringify(v));
    writeFileSync(join(dir, "notes.md"), "- claim: verified\n");
    return vdir;
  }
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...gitFreeEnv(), PATH: "/usr/bin:/bin" } });

  it("composes against the deployed preview with notes, writes nothing", () => {
    const vdir = seed({ target_url: "https://pr-2570.preview.example", evidence_redacted: true });
    const before = readdirSync(vdir).sort();
    const r = cli("--dry-run", "--pr", "2570", "--notes-file", "notes.md");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toContain("deployed preview");
    expect(r.stdout).toContain("### Acceptance verdict:");
    expect(r.stdout).toContain("#### Reviewer notes");
    expect(r.stderr).toMatch(/dry-run: composed body for pr 2570/);
    expect(readdirSync(vdir).sort()).toEqual(before);
    expect(existsSync(join(dir, "docs/plans"))).toBe(false);
  });

  it("an unreadable --notes-file refuses (no body, exit 0)", () => {
    seed({});
    const r = cli("--dry-run", "--pr", "2570", "--notes-file", "missing.md");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/notes-file/);
  });

  it("an invalid --pr refuses (no body, exit 0)", () => {
    seed({});
    const r = cli("--dry-run", "--pr", "abc");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/--pr/);
  });
});

describe("text evidence", () => {
  const capture = "GET /api/orders\nstatus 200\n";
  const readText = (p) => (p.endsWith("long.txt") ? Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") : capture);
  const v = () => buildVerdict({ "workflow-fit": ["cap.txt", "a.png"] });

  it("splits by extension: images attach, text does not", () => {
    const sel = selectEvidence(v(), existsAll);
    expect(sel.files).toEqual(["a.png"]);
    expect(sel.text).toEqual(["cap.txt"]);
    expect(ghArgs({ kind: "pr", number: 1 }, "b.md", sel.files)).toEqual(["pr", "comment", "1", "--body-file", "b.md", "--attach", "a.png#a"]);
  });

  it("renders text as a fenced excerpt and images as references", () => {
    const body = composeComment(v(), selectEvidence(v(), existsAll), { readText });
    expect(body).toContain("```text\nGET /api/orders\nstatus 200\n```");
    expect(body).toContain("![a](a.png)");
    expect(body).not.toContain("](cap.txt)");
  });

  it("cuts a 60-line capture to 40 lines plus a tail", () => {
    const long = buildVerdict({ "workflow-fit": ["long.txt"] });
    const body = composeComment(long, selectEvidence(long, existsAll), { readText });
    expect(body).toContain("line 40\n");
    expect(body).not.toContain("line 41");
    expect(body).toContain("… (20 more lines)");
  });

  it("a fence inside a capture cannot close the excerpt", () => {
    const body = composeComment(v(), selectEvidence(v(), existsAll), { readText: () => "```\nbreakout\n```" });
    expect(body).toContain("````text\n```\nbreakout\n```\n````");
  });

  it("an API-only verdict attaches nothing", () => {
    const api = buildVerdict({ "workflow-fit": ["cap.txt"] });
    const gh = vi.fn(() => "");
    const r = run(
      {
        gh,
        writeMarker: vi.fn(),
        writeBody: () => "/tmp/b.md",
        headSha7: () => SHA7,
        findVerdict: () => ({ path: `build-${SHA7}-h-f.json`, verdict: api }),
        exists: existsAll,
        readText,
        alreadyPosted: () => false,
        prNumber: () => 7,
        branch: () => "x",
      },
      {},
    );
    expect(r.posted).toBe(true);
    expect(gh.mock.calls[0][0]).not.toContain("--attach");
    expect(r.body).toContain("status 200");
  });

  it("refuses a remote verdict whose only evidence is text unless marked redacted", () => {
    const remote = { ...buildVerdict({ "workflow-fit": ["cap.txt"] }), target_url: "https://x.preview.example" };
    const deps = {
      gh: vi.fn(),
      writeMarker: vi.fn(),
      writeBody: () => "/tmp/b.md",
      headSha7: () => SHA7,
      findVerdict: () => ({ path: "build-x.json", verdict: remote }),
      exists: existsAll,
      readText,
      alreadyPosted: () => false,
      prNumber: () => 7,
      branch: () => "x",
    };
    const r = run(deps, {});
    expect(r.posted).toBe(false);
    expect(r.note).toMatch(/redact/i);
    expect(deps.gh).not.toHaveBeenCalled();
  });

  it("the idempotency check covers text evidence as well as images", () => {
    const alreadyPosted = vi.fn(() => true);
    run(
      {
        gh: vi.fn(),
        writeMarker: vi.fn(),
        writeBody: () => "/tmp/b.md",
        headSha7: () => SHA7,
        findVerdict: () => ({ path: "build-x.json", verdict: v() }),
        exists: existsAll,
        readText,
        alreadyPosted,
        prNumber: () => 7,
        branch: () => "x",
      },
      {},
    );
    expect(alreadyPosted.mock.calls[0][2]).toEqual(["a.png", "cap.txt"]);
  });
});

describe("postedMarkerPath", () => {
  it("keys the marker on the 7-char sha", () => {
    expect(postedMarkerPath(SHA7)).toBe(".tmp/acceptance/posted-abc1234.json");
  });
});
