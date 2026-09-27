import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseLaneContract,
  orderLanes,
  resolveLanePr,
  authenticateStateComment,
  latestAuthenticatedState,
  deriveLaneState,
  evaluateStartGate,
  evaluateChecklist,
  selectUniqueRun,
  postMergeBar,
  barOutcome,
  barRunMismatch,
  nextAction,
  LaneContractError,
  LaneOrderError,
  UniqueRunError,
} from "./spine.mjs";
import { computeSpineStatus } from "./run.mjs";
import { DEFAULTS } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EPIC = JSON.parse(readFileSync(join(HERE, "__fixtures__", "spine-epic.json"), "utf8"));
const RUNS = JSON.parse(readFileSync(join(HERE, "__fixtures__", "workflow-runs.json"), "utf8"));
// A consumer repo's config: push-mode bar.
const CONSUMER = JSON.parse(readFileSync(join(HERE, "__fixtures__", "pm-config-consumer.json"), "utf8"));
// Every key set: a dispatch-mode preview bar, a preview context, a [skip-cd] convention.
const FULL = { ...DEFAULTS, ...JSON.parse(readFileSync(join(HERE, "__fixtures__", "pm-config-full.json"), "utf8")) };

// Frozen clock for the unit's time-dependent (unique-run) block. Mid-month
// weekday, no nearby DST boundary (US DST ends in November). Exported so E2E
// fixtures can anchor to the same instant.
export const FROZEN_NOW = new Date("2026-09-16T12:00:00.000Z").getTime();

const IDENTITY = EPIC.automationIdentity; // "acme-bot"
const AUTHORS = EPIC.expectedAuthors;
const subIssue = (n) => EPIC.subIssues.find((s) => s.number === n);

// Build a lane sub-issue body from a fields object, for parse-failure cases.
const laneBody = (fields) => {
  const lines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      v.forEach((i) => lines.push(`  - ${i}`));
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return `Intro line.\n\n\`\`\`yaml\n${lines.join("\n")}\n\`\`\`\n\nPart of #1965.\n`;
};

const validFields = () => ({
  plan: "docs/plans/2026-09-01-1509-fix-1-x-plan.md",
  lane: "LX",
  kind: "preview",
  branch: "fix-1-x",
  "allowed-paths": ["package.json"],
});

// -----------------------------------------------------------------------
describe("parseLaneContract (R2, R25)", () => {
  it("a #1965-shaped sub-issue body yields the lane fields", () => {
    const lane = parseLaneContract(subIssue(1966).body, { subIssue: 1966 });
    expect(lane.lane).toBe("L1");
    expect(lane.kind).toBe("preview");
    expect(lane.operator).toBe(false);
    expect(lane.branch).toBe("fix-1966-dep-catchup");
    expect(lane.plan).toBe("docs/plans/2026-09-01-1509-fix-220-dep-catchup-plan.md");
    expect(lane.packages).toEqual(["react", "react-dom", "@types/react"]);
    expect(lane.allowedPaths).toEqual([
      "package.json",
      "package-lock.json",
      "docs/plans/2026-09-01-1509-fix-220-dep-catchup-plan.md",
      "docs/solutions/**",
    ]);
  });

  it("kind: preview + operator parses as preview with operator: true (KTD8)", () => {
    const lane = parseLaneContract(subIssue(1345).body, { subIssue: 1345 });
    expect(lane.kind).toBe("preview");
    expect(lane.operator).toBe(true);
  });

  it("a body missing branch throws a named error identifying the sub-issue and field", () => {
    const noBranch = validFields();
    delete noBranch.branch;
    let thrown;
    try {
      parseLaneContract(laneBody(noBranch), { subIssue: 1966 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LaneContractError);
    expect(thrown.field).toBe("branch");
    expect(thrown.subIssue).toBe(1966);
    expect(thrown.message).toMatch(/#1966/);
    expect(thrown.message).toMatch(/branch/);
  });

  it("a bad branch shape is rejected (untrusted field, Risks)", () => {
    expect(() => parseLaneContract(laneBody({ ...validFields(), branch: "Fix/1-x" }), { subIssue: 1 })).toThrow(
      /branch/,
    );
  });

  it("no fenced yaml block throws", () => {
    expect(() => parseLaneContract("no yaml here", { subIssue: 7 })).toThrow(LaneContractError);
  });

  it("strips the human annotation from an allowed-path entry (src/** (...))", () => {
    const lane = parseLaneContract(subIssue(1968).body, { subIssue: 1968 });
    expect(lane.allowedPaths).toContain("src/**");
    expect(lane.allowedPaths).toContain("server/tsconfig.json");
  });

  it("reads the optional post-merge-runs key from the fixture's L4 lane (R9)", () => {
    expect(parseLaneContract(subIssue(1969).body, { subIssue: 1969 }).postMergeRuns).toBe(3);
    expect(parseLaneContract(subIssue(1966).body, { subIssue: 1966 }).postMergeRuns).toBeNull();
  });

  it("a non-positive-integer post-merge-runs is refused", () => {
    expect(() => parseLaneContract(laneBody({ ...validFields(), "post-merge-runs": "two" }), { subIssue: 4 })).toThrow(
      /post-merge-runs/,
    );
  });

  it("a lane naming the bar workflow is refused by name (R9)", () => {
    for (const key of ["verificationWorkflow", "choreWorkflow"]) {
      let thrown;
      try {
        parseLaneContract(laneBody({ ...validFields(), [key]: "x.yml" }), { subIssue: 4 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(LaneContractError);
      expect(thrown.message).toMatch(key);
      expect(thrown.message).toMatch(/R9/);
    }
  });

  // #2153: flow (inline) lists are valid YAML a hand-authored lane may use.
  it("parses flow-list packages instead of silently emptying the scope (#2153)", () => {
    const lane = parseLaneContract(laneBody({ ...validFields(), packages: "[vite, react]" }), { subIssue: 2153 });
    expect(lane.packages).toEqual(["vite", "react"]);
  });

  it("refuses an unparsed flow list instead of emptying packages (#2153)", () => {
    for (const packages of ["[vite] # bump", "[vite", "['vite']"]) {
      expect(() => parseLaneContract(laneBody({ ...validFields(), packages }), { subIssue: 2153 })).toThrow(/"packages" must be a list/);
    }
  });

  it("refuses a flow item annotation whose comma would mint a second scope (#2153)", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), "allowed-paths": "[src/lib/** (fix, server/ too)]" }), { subIssue: 2153 }),
    ).toThrow(/"allowed-paths" must be a list/);
  });

  it("parses flow-list allowed-paths instead of reporting it missing (#2153)", () => {
    const lane = parseLaneContract(laneBody({ ...validFields(), "allowed-paths": "[src/, docs/plans/**]" }), { subIssue: 2153 });
    expect(lane.allowedPaths).toEqual(["src", "docs/plans/**"]);
  });
});

describe("traversal-safe path validation (R25)", () => {
  it("a plan escaping docs/plans via .. throws", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), plan: "docs/plans/../../etc/x.md" }), { subIssue: 3 }),
    ).toThrow(/traversal/i);
  });

  it("an allowed-path with .. throws", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), "allowed-paths": ["../secrets"] }), { subIssue: 3 }),
    ).toThrow(/traversal/i);
  });

  it("an absolute plan path throws", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), plan: "/etc/passwd.md" }), { subIssue: 3 }),
    ).toThrow(LaneContractError);
  });

  it("a plan outside docs/plans throws even without traversal", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), plan: "docs/notes/x.md" }), { subIssue: 3 }),
    ).toThrow(/docs\/plans/);
  });

  it("a backslash path throws", () => {
    expect(() =>
      parseLaneContract(laneBody({ ...validFields(), "allowed-paths": ["src\\win.ts"] }), { subIssue: 3 }),
    ).toThrow(/backslash/i);
  });
});

// -----------------------------------------------------------------------
describe("orderLanes (R1)", () => {
  it("orders lanes by the epic checklist: L1 L2 L3 L4 L6 L5 L7", () => {
    const ordered = orderLanes(EPIC.epic.body, EPIC.subIssues);
    expect(ordered.map((s) => s.number)).toEqual([1966, 1967, 1968, 1969, 1345, 1970, 1971]);
  });

  it("ignores an API-only sub-issue absent from the lane checklist (a deferred major, not a lane)", () => {
    // Real epic #1965 attaches deferred-major sub-issues (#1972–#1976) alongside
    // the 7 lanes; the lane checklist is authoritative, so API-only members are
    // ignored, never an error (verified live on #1965).
    const withDeferred = [...EPIC.subIssues, { number: 1972, body: "" }, { number: 1973, body: "" }];
    const ordered = orderLanes(EPIC.epic.body, withDeferred);
    expect(ordered.map((s) => s.number)).toEqual([1966, 1967, 1968, 1969, 1345, 1970, 1971]);
    expect(ordered.map((s) => s.number)).not.toContain(1972);
  });

  it("throws when the checklist names a sub-issue absent from the API set", () => {
    const fewer = EPIC.subIssues.filter((s) => s.number !== 1971);
    expect(() => orderLanes(EPIC.epic.body, fewer)).toThrow(LaneOrderError);
  });

  it("throws on an empty lane checklist", () => {
    expect(() => orderLanes("### Notes\n\nno checkboxes here", [])).toThrow(/empty lane checklist/);
  });
});

// -----------------------------------------------------------------------
describe("resolveLanePr (R22)", () => {
  const pr = (extra = {}) => ({
    number: 10,
    headRefName: "fix-1968-typescript-6",
    baseRefName: "main",
    isCrossRepository: false,
    headRepositoryOwner: { login: "acme" },
    author: { login: "acme-bot" },
    state: "OPEN",
    ...extra,
  });
  const lane = { branch: "fix-1968-typescript-6" };

  it("resolves the one identity-bound PR", () => {
    const r = resolveLanePr([pr()], lane, AUTHORS);
    expect(r.pr.number).toBe(10);
    expect(r.refused).toBeUndefined();
  });

  it("refuses a fork head", () => {
    const r = resolveLanePr([pr({ isCrossRepository: true, headRepositoryOwner: { login: "attacker" } })], lane, AUTHORS);
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/fork-head/);
  });

  it("refuses a wrong base", () => {
    const r = resolveLanePr([pr({ baseRefName: "develop" })], lane, AUTHORS);
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/wrong-base/);
  });

  it("binds the base to config baseBranch: with develop, a main-based PR is wrong-base", () => {
    const develop = { baseBranch: "develop" };
    expect(resolveLanePr([pr()], lane, AUTHORS, develop).reason).toMatch(/wrong-base/);
    expect(resolveLanePr([pr({ baseRefName: "develop" })], lane, AUTHORS, develop).pr.number).toBe(10);
  });

  it("refuses a stale same-named PR by an unexpected author", () => {
    const r = resolveLanePr([pr({ author: { login: "drive-by" } })], lane, AUTHORS);
    expect(r.refused).toBe(true);
    expect(r.reason).toMatch(/unexpected-author/);
  });

  it("refuses when two PRs both pass the identity check", () => {
    const r = resolveLanePr([pr({ number: 10 }), pr({ number: 11 })], lane, AUTHORS);
    expect(r).toEqual({ refused: true, reason: "multiple" });
  });

  it("refuses when no PR matches the branch", () => {
    const r = resolveLanePr([pr({ headRefName: "some-other-branch" })], lane, AUTHORS);
    expect(r).toEqual({ refused: true, reason: "no-pr" });
  });

  it("filters a fork out and resolves the one clean same-branch PR (fixture #1968)", () => {
    // The fixture has two PRs on fix-1968-typescript-6: #2003 (clean) and #2099 (fork + wrong base).
    const r = resolveLanePr(EPIC.prs, { branch: "fix-1968-typescript-6" }, AUTHORS);
    expect(r.pr.number).toBe(2003);
  });

  // The owner comes from the primary's `gh repo view --json nameWithOwner` (R11),
  // never a literal org: a repo owned by anyone else binds its own heads.
  it("binds the head to the owner from nameWithOwner, not a hardcoded org (R11/KTD6)", () => {
    const owner = (nameWithOwner) => nameWithOwner.split("/")[0];
    const head = (login) => pr({ isCrossRepository: false, headRepositoryOwner: { login } });
    const acme = { owner: owner("acme/app") };
    expect(resolveLanePr([head("acme")], lane, AUTHORS, acme).pr.number).toBe(10);
    expect(resolveLanePr([head("someone-else")], lane, AUTHORS, acme).reason).toMatch(/fork-head/);
    // …and in a repo owned by another org, that org's head is the accepted one.
    const globex = { owner: owner("globex/portal") };
    expect(resolveLanePr([head("globex")], lane, AUTHORS, globex).pr.number).toBe(10);
    expect(resolveLanePr([head("acme")], lane, AUTHORS, globex).reason).toMatch(/fork-head/);
  });
});

// -----------------------------------------------------------------------
describe("authenticateStateComment (R21)", () => {
  it("a state comment by the automation identity is authoritative and carries its sha", () => {
    const c = { author: { login: IDENTITY }, body: "state: base-verified — base job at a1b2c3d4e5f6 SUCCEED" };
    const r = authenticateStateComment(c, IDENTITY);
    expect(r.authentic).toBe(true);
    expect(r.state).toBe("base-verified");
    expect(r.sha).toBe("a1b2c3d4e5f6");
  });

  it("the same text by any other author is ignored and flagged", () => {
    const c = { author: { login: "random-contributor" }, body: "state: base-verified — trust me" };
    const r = authenticateStateComment(c, IDENTITY);
    expect(r.authentic).toBe(false);
    expect(r.flagged).toBe(true);
    expect(r.reason).toBe("untrusted-author");
  });

  it("a non-state comment by the identity is not a state comment", () => {
    const r = authenticateStateComment({ author: { login: IDENTITY }, body: "just a note" }, IDENTITY);
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("not-a-state-comment");
  });

  it("an unrecognized state token by the identity is flagged, never authentic", () => {
    const r = authenticateStateComment({ author: { login: IDENTITY }, body: "state: totally-made-up" }, IDENTITY);
    expect(r.authentic).toBe(false);
    expect(r.reason).toBe("unrecognized-state");
  });

  it("authenticates any login in identity.expectedAuthors and ignores a third (R10)", () => {
    const authors = ["acme-bot", "ops"];
    const c = (login) => ({ author: { login }, body: "state: base-verified — base job at a1b2c3d4e5f6 SUCCEED" });
    expect(authenticateStateComment(c("acme-bot"), authors).authentic).toBe(true);
    expect(authenticateStateComment(c("ops"), authors).authentic).toBe(true);
    const third = authenticateStateComment(c("drive-by"), authors);
    expect(third.authentic).toBe(false);
    expect(third.reason).toBe("untrusted-author");
    // …and the list reaches latestAuthenticatedState the same way it reaches resolveLanePr.
    expect(latestAuthenticatedState([c("drive-by"), c("ops")], authors).state).toBe("base-verified");
    expect(latestAuthenticatedState([c("drive-by")], authors)).toBeNull();
  });

  it("latestAuthenticatedState ignores a spoofed base-verified and keeps the real last state", () => {
    const comments = [...subIssue(1968).comments, EPIC.spoofedComment.comment];
    const last = latestAuthenticatedState(comments, IDENTITY);
    // queued then spawned are authentic; the spoofed base-verified is ignored.
    expect(last.state).toBe("spawned");
  });
});

// -----------------------------------------------------------------------
describe("deriveLaneState (R16, KTD4)", () => {
  const preview = { kind: "preview" };

  it("no PR and no live worker → queued / start-gate", () => {
    const r = deriveLaneState({ lane: preview, posted: null, pr: null, roster: [], worktrees: [{ path: "/x" }], workerName: "w1971" });
    expect(r).toEqual({ state: "queued", step: "start-gate" });
  });

  it("no PR with the worker working → spawned / watch", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: "spawned",
      pr: null,
      roster: [{ name: "w1968", agent_status: "working" }],
      worktrees: [{ path: "/w/x" }],
      workerName: "w1968",
    });
    expect(r).toEqual({ state: "spawned", step: "watch" });
  });

  it("roster/worktrees absent → last posted state with a caveat, never a derived spawned (R16)", () => {
    const r = deriveLaneState({ lane: preview, posted: "queued", pr: null, workerName: "w1968" });
    expect(r.state).toBe("queued");
    expect(r.state).not.toBe("spawned");
    expect(r.step).toBe("needs-roster");
    expect(r.caveat).toMatch(/roster not supplied/i);
  });

  it("roster absent never re-derives a watch/spawn step even when spawned was posted (no double-spawn)", () => {
    const r = deriveLaneState({ lane: preview, posted: "spawned", pr: null, workerName: "w1968" });
    expect(r.step).toBe("needs-roster");
    expect(["watch", "spawn", "start-gate"]).not.toContain(r.step);
  });

  it("PR open with e2e/report PENDING → pushed / babysit", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: "spawned",
      pr: { state: "OPEN" },
      checks: { previewReport: "PENDING", requiredChecksGreen: false, mergeStateStatus: "BLOCKED" },
    });
    expect(r).toEqual({ state: "pushed", step: "babysit" });
  });

  it("PR open, all green and CLEAN → preview-green / checklist", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: "spawned",
      pr: { state: "OPEN" },
      checks: { previewReport: "SUCCESS", requiredChecksGreen: true, mergeStateStatus: "CLEAN" },
    });
    expect(r).toEqual({ state: "preview-green", step: "checklist" });
  });

  it("a null previewContext drops the preview-report requirement for a preview lane (R6/KTD5)", () => {
    // A consumer with no preview status context: the required checks alone prove green.
    const checks = { requiredChecksGreen: true, mergeStateStatus: "CLEAN" };
    const base = { lane: preview, posted: "spawned", pr: { state: "OPEN" }, checks };
    expect(deriveLaneState({ ...base, previewContext: FULL.checks.previewContext })).toEqual({ state: "pushed", step: "babysit" });
    expect(deriveLaneState({ ...base, previewContext: null })).toEqual({ state: "preview-green", step: "checklist" });
  });

  it("a chore lane needs no preview report to be green", () => {
    const r = deriveLaneState({
      lane: { kind: "chore" },
      posted: "spawned",
      pr: { state: "OPEN" },
      checks: { requiredChecksGreen: true, mergeStateStatus: "CLEAN" },
    });
    expect(r).toEqual({ state: "preview-green", step: "checklist" });
  });

  it("PR MERGED with last posted spawned → merged / post-merge bar", () => {
    const r = deriveLaneState({ lane: preview, posted: "spawned", pr: { state: "MERGED" } });
    expect(r).toEqual({ state: "merged", step: "post-merge-bar" });
  });

  // A bar that could not run posts `blocked-infra <merge-sha>` (R8). Resume must
  // NOT re-run it: the posting wins over the MERGED PR, but ONLY when it is bound
  // to that merge commit — a lane blocked and recovered BEFORE merge still owes
  // its bar (KTD4).
  it("a blocked-infra posting AT the merge commit beats MERGED → escalate-infra", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: { state: "blocked-infra", sha: "merge1966aaaa" },
      pr: { state: "MERGED", mergeCommit: { oid: "merge1966aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    expect(r).toEqual({ state: "blocked-infra", step: "escalate-infra" });
  });

  it("a blocked-infra posting at ANOTHER commit → the lane still owes its bar", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: { state: "blocked-infra", sha: "beforethemerge" },
      pr: { state: "MERGED", mergeCommit: { oid: "merge1966aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    expect(r).toEqual({ state: "merged", step: "post-merge-bar" });
  });

  it("a blocked-infra posting with no recorded sha → the lane still owes its bar", () => {
    const r = deriveLaneState({
      lane: preview,
      posted: { state: "blocked-infra", sha: null },
      pr: { state: "MERGED", mergeCommit: { oid: "merge1966aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    expect(r).toEqual({ state: "merged", step: "post-merge-bar" });
  });

  it("no posting at all + MERGED → post-merge bar (unchanged)", () => {
    expect(deriveLaneState({ lane: preview, posted: null, pr: { state: "MERGED" } })).toEqual({
      state: "merged",
      step: "post-merge-bar",
    });
  });

  it("last posted base-verified → close", () => {
    expect(deriveLaneState({ lane: preview, posted: "base-verified", pr: { state: "MERGED" } })).toEqual({
      state: "base-verified",
      step: "close",
    });
  });

  it("last posted chore-verified → close", () => {
    expect(deriveLaneState({ lane: { kind: "chore" }, posted: "chore-verified" })).toEqual({
      state: "chore-verified",
      step: "close",
    });
  });

  it("last posted closed → next lane", () => {
    expect(deriveLaneState({ lane: preview, posted: "closed" })).toEqual({ state: "closed", step: "next" });
  });

  it("last posted base-regressed → halt", () => {
    expect(deriveLaneState({ lane: preview, posted: "base-regressed" })).toEqual({
      state: "base-regressed",
      step: "halt",
    });
  });

  it("integration: the three staged fixture lanes map to babysit / checklist / post-merge bar", () => {
    const ordered = orderLanes(EPIC.epic.body, EPIC.subIssues);
    const stepFor = (n) => {
      const s = ordered.find((x) => x.number === n);
      const lane = parseLaneContract(s.body, { subIssue: n });
      const resolution = resolveLanePr(EPIC.prs, lane, AUTHORS);
      const posted = latestAuthenticatedState(s.comments, IDENTITY);
      return deriveLaneState({
        lane,
        posted,
        pr: resolution.pr ?? null,
        checks: resolution.pr?.checks ?? {},
        roster: EPIC.roster,
        worktrees: EPIC.worktrees,
        workerName: `w${n}`,
      });
    };
    expect(stepFor(1966).step).toBe("post-merge-bar"); // MERGED
    expect(stepFor(1968).step).toBe("babysit"); // PR open, not green
    expect(stepFor(1969).step).toBe("checklist"); // PR open, green
    // an untouched lane with no PR → queued / start-gate
    expect(stepFor(1971).step).toBe("start-gate");
  });
});

// -----------------------------------------------------------------------
describe("evaluateStartGate (R6)", () => {
  const ok = {
    primaryHead: "abc",
    originBase: "abc",
    predecessor: { verified: true },
    identityLogin: "acme-bot",
    expectedAuthors: ["acme-bot"],
    configDirty: false,
    configDigest: "aaaaaaaaaaaa",
  };

  it("a fully satisfied gate is ok with no reasons", () => {
    expect(evaluateStartGate(ok)).toEqual({ ok: true, reasons: [] });
  });

  it("HEAD != origin/<base> → primary-behind", () => {
    expect(evaluateStartGate({ ...ok, primaryHead: "xyz" }).reasons).toContain("primary-behind");
  });

  it("predecessor not verified → predecessor-unverified", () => {
    expect(evaluateStartGate({ ...ok, predecessor: { verified: false } }).reasons).toContain("predecessor-unverified");
  });

  it("reports every failing reason together, not first-only", () => {
    const r = evaluateStartGate({ ...ok, primaryHead: "xyz", predecessor: { verified: false }, configDirty: true });
    expect(r.reasons).toEqual(expect.arrayContaining(["primary-behind", "predecessor-unverified", "config-dirty"]));
  });

  // --- KTD6/R10: the session's gh login must be a configured author ---

  it("a login outside identity.expectedAuthors → identity-unexpected (AE7)", () => {
    const r = evaluateStartGate({ ...ok, identityLogin: "some-human" });
    expect(r.reasons).toContain("identity-unexpected");
    expect(r.ok).toBe(false);
  });

  it("an unresolved login refuses rather than skipping the check (fail closed)", () => {
    expect(evaluateStartGate({ ...ok, identityLogin: undefined }).reasons).toContain("identity-unexpected");
    expect(evaluateStartGate({ ...ok, expectedAuthors: undefined }).reasons).toContain("identity-unexpected");
  });

  // --- KTD3: the config must be committed, and still the one this campaign spawned under ---

  it("uncommitted changes under the config file or the scripts → config-dirty", () => {
    const r = evaluateStartGate({ ...ok, configDirty: true });
    expect(r.reasons).toContain("config-dirty");
    expect(r.ok).toBe(false);
  });

  it("a digest differing from the last spawned comment's config= → config-drift", () => {
    const r = evaluateStartGate({ ...ok, configDigest: "aaaaaaaaaaaa", lastSpawnedDigest: "bbbbbbbbbbbb" });
    expect(r.reasons).toContain("config-drift");
  });

  it("--accept-config matching the primary's digest clears the drift", () => {
    const r = evaluateStartGate({
      ...ok,
      configDigest: "aaaaaaaaaaaa",
      lastSpawnedDigest: "bbbbbbbbbbbb",
      acceptedDigest: "aaaaaaaaaaaa",
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it("an accepted digest that is not the primary's does NOT clear the drift", () => {
    const r = evaluateStartGate({
      ...ok,
      configDigest: "aaaaaaaaaaaa",
      lastSpawnedDigest: "bbbbbbbbbbbb",
      acceptedDigest: "bbbbbbbbbbbb",
    });
    expect(r.reasons).toContain("config-drift");
  });

  it("no spawned comment yet (no recorded digest) is not drift", () => {
    expect(evaluateStartGate({ ...ok, lastSpawnedDigest: undefined }).reasons).toEqual([]);
  });
});

// -----------------------------------------------------------------------
describe("evaluateChecklist (R10, R23, KTD11)", () => {
  const cleanL3 = {
    lane: {
      kind: "preview",
      subIssue: 1968,
      plan: "docs/plans/2026-09-01-1509-fix-220-typescript-6-plan.md",
      allowedPaths: ["package.json", "package-lock.json", "tsconfig.json", "server/tsconfig.json", "src/**", "docs/plans/2026-09-01-1509-fix-220-typescript-6-plan.md", "docs/solutions/**"],
    },
    subjects: ["fix(deps): typescript 6.0.3", "test: explicit types lists"],
    files: ["package.json", "package-lock.json", "tsconfig.json", "server/tsconfig.json", "src/hooks/useThing.ts", "docs/plans/2026-09-01-1509-fix-220-typescript-6-plan.md"],
    body: "Bumps TypeScript.\n\nCloses #1968",
    parcelWatcherCount: 13,
    policy: FULL.subjects,
  };

  it("a clean L3-shaped input passes with no violations", () => {
    expect(evaluateChecklist(cleanL3)).toEqual({ ok: true, violations: [] });
  });

  it("a preview lane with a [skip-cd] subject → skip-cd-on-preview", () => {
    const r = evaluateChecklist({ ...cleanL3, subjects: ["fix(deps): bump [skip-cd]"] });
    expect(r.violations).toContain("skip-cd-on-preview");
  });

  it("a chore lane with an untagged subject → skip-cd-missing", () => {
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, kind: "chore" },
      subjects: ["chore: bump gha majors"],
    });
    expect(r.violations).toContain("skip-cd-missing");
  });

  // A PREVIEW lane is where runtime work lands, and the commit type follows
  // runtime impact — so feat:/fix:/refactor: are exactly right
  // there, and are what trigger the preview build this lane kind exists to prove.
  // The original list was the dependency campaign's vocabulary (`fix(deps)` only).
  it("a preview lane admits the runtime-impact prefixes", () => {
    for (const s of ["feat: new thing", "fix: a bug", "fix(candidate-landing): read the right company", "refactor(x): reuse the type"]) {
      expect(evaluateChecklist({ ...cleanL3, subjects: [s] }).violations).not.toContain("subject-prefix");
    }
  });

  // A chore lane must NOT carry a runtime prefix — that is the branch-type rule
  // (`chore-` does not deploy), so this half of the old assertion still holds.
  it("a chore lane still rejects the runtime-impact prefixes", () => {
    const lane = { ...cleanL3.lane, kind: "chore" };
    for (const s of ["feat: new thing [skip-cd]", "fix: a bug [skip-cd]", "refactor: x [skip-cd]"]) {
      expect(evaluateChecklist({ ...cleanL3, lane, subjects: [s] }).violations).toContain("subject-prefix");
    }
  });

  // `fix` must admit a conventional scope without admitting a longer word.
  it("a bare prefix does not admit a longer token that merely starts with it", () => {
    expect(evaluateChecklist({ ...cleanL3, subjects: ["fixup: squash me"] }).violations).toContain("subject-prefix");
  });

  it("a changed path outside allowed-paths → outside-allowed-paths", () => {
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, allowedPaths: ["package.json"] },
      files: ["src/x.ts"],
    });
    expect(r.violations).toContain("outside-allowed-paths");
  });

  it("a protected path is refused even when listed in allowed-paths (R23)", () => {
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, allowedPaths: [".github/workflows/**", ...cleanL3.lane.allowedPaths] },
      files: [".github/workflows/deploy.yml"],
    });
    expect(r.violations).toContain("protected-path");
  });

  it("each protected boundary prefix is refused", () => {
    for (const f of [".claude/settings.json", ".agents/skills/x", ".husky/pre-push", ".github/workflows/ci.yml"]) {
      const r = evaluateChecklist({ ...cleanL3, files: [f] });
      expect(r.violations).toContain("protected-path");
    }
  });

  it("config protectedPaths are refused at segment boundaries, alongside the built-ins", () => {
    const lane = { ...cleanL3.lane, allowedPaths: ["ops/**", "opsx/**", ".agents/**"] };
    const check = (f) => evaluateChecklist({ ...cleanL3, lane, protectedPaths: ["ops/"], files: [f] }).violations;
    expect(check("ops/a")).toContain("protected-path");
    expect(check(".agents/skills/x")).toContain("protected-path");
    expect(check("opsx/a")).not.toContain("protected-path");
    // Without the config entry, ops/ is an ordinary allowed path.
    expect(evaluateChecklist({ ...cleanL3, lane, files: ["ops/a"] }).violations).not.toContain("protected-path");
  });

  it("a foreign docs/plans change → foreign-plan", () => {
    const r = evaluateChecklist({ ...cleanL3, files: ["docs/plans/other-plan.md"] });
    expect(r.violations).toContain("foreign-plan");
  });

  // An acceptance convention may write ONE Gherkin artifact per plan, as a `.feature`
  // sibling of the plan file, so a normal lane carries two docs/plans/ files. That
  // sibling is the lane's own artifact, not a foreign plan.
  it("the lane's own .feature acceptance sibling is NOT foreign-plan", () => {
    const sibling = cleanL3.lane.plan.replace(/\.md$/, ".feature");
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, allowedPaths: [...cleanL3.lane.allowedPaths, sibling] },
      files: [...cleanL3.files, sibling],
    });
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it("a .feature belonging to a DIFFERENT plan is still foreign-plan", () => {
    const r = evaluateChecklist({ ...cleanL3, files: [...cleanL3.files, "docs/plans/some-other-plan.feature"] });
    expect(r.violations).toContain("foreign-plan");
  });

  it("a PR body without Closes #<sub> → closes-missing", () => {
    const r = evaluateChecklist({ ...cleanL3, body: "no closing keyword here" });
    expect(r.violations).toContain("closes-missing");
  });

  it("a lockfile @parcel/watcher count below 13 → parcel-watcher-count (KTD11)", () => {
    const r = evaluateChecklist({ ...cleanL3, parcelWatcherCount: 12 });
    expect(r.violations).toContain("parcel-watcher-count");
  });

  it("a null @parcel/watcher count (lockfile unchanged / lane not opted in) does not violate", () => {
    const r = evaluateChecklist({ ...cleanL3, parcelWatcherCount: null });
    expect(r.violations).not.toContain("parcel-watcher-count");
  });

  it("folds in an R22 refusal as pr-identity", () => {
    const r = evaluateChecklist({ ...cleanL3, prResolution: { refused: true, reason: "fork-head" } });
    expect(r.violations).toContain("pr-identity");
  });

  // --- the subject policy comes from config (R2, KTD2) --------------------
  // Everything above runs on the full fixture's rules; these pin the
  // same code against a consumer policy handed in as `policy`.
  const CONSUMER_POLICY = {
    preview: { prefixes: ["feat", "fix", "chore", "docs", "test"], skipCd: "ignored" },
    chore: { prefixes: ["chore", "docs", "test"], skipCd: "ignored" },
  };

  it("a consumer policy admitting feat: accepts it on a preview lane (AE2)", () => {
    const r = evaluateChecklist({ ...cleanL3, policy: CONSUMER_POLICY, subjects: ["feat: add app"] });
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it("a consumer policy with skipCd ignored passes an untagged chore lane (AE2)", () => {
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, kind: "chore" },
      policy: CONSUMER_POLICY,
      subjects: ["chore: bump gha majors"],
    });
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it("the config file is protected even when the lane lists it in allowed-paths (AE3/KTD3)", () => {
    const r = evaluateChecklist({
      ...cleanL3,
      lane: { ...cleanL3.lane, allowedPaths: [".multi-worker-pm.json", ...cleanL3.lane.allowedPaths] },
      files: [".multi-worker-pm.json"],
    });
    expect(r.violations).toContain("protected-path");
  });
});

// -----------------------------------------------------------------------
describe("selectUniqueRun (R13, KTD6 — frozen clock)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const since = () => new Date(FROZEN_NOW).toISOString();
  const at = (ms) => new Date(FROZEN_NOW + ms).toISOString();
  const run = (databaseId, offsetMs, headSha, login = "alice") => ({
    databaseId,
    createdAt: at(offsetMs),
    headSha,
    actor: { login },
  });

  it("one run by ME at FROZEN_NOW + 5s with the matching headSha → selected", () => {
    const r = selectUniqueRun({ runs: [run(1, 5_000, "merge-sha")], since: since(), actor: "alice", sha: "merge-sha" });
    expect(r).toEqual({ id: 1 });
  });

  it("a same-actor run after `since` with a DIFFERENT headSha → none", () => {
    const r = selectUniqueRun({ runs: [run(2, 6_000, "other-sha")], since: since(), actor: "alice", sha: "merge-sha" });
    expect(r).toEqual({ none: true });
  });

  it("a run at FROZEN_NOW − 1s (before `since`) → none", () => {
    const r = selectUniqueRun({ runs: [run(3, -1_000, "merge-sha")], since: since(), actor: "alice", sha: "merge-sha" });
    expect(r).toEqual({ none: true });
  });

  it("two matching-headSha runs by ME after `since` → ambiguous with both ids", () => {
    const r = selectUniqueRun({
      runs: [run(4, 5_000, "merge-sha"), run(5, 9_000, "merge-sha")],
      since: since(),
      actor: "alice",
      sha: "merge-sha",
    });
    expect(r).toEqual({ ambiguous: [4, 5] });
  });

  it("a run by another actor → none", () => {
    const r = selectUniqueRun({ runs: [run(6, 5_000, "merge-sha", "someone-else")], since: since(), actor: "alice", sha: "merge-sha" });
    expect(r).toEqual({ none: true });
  });

  it("since omitted → throws (fail closed, KTD6)", () => {
    expect(() => selectUniqueRun({ runs: [], sha: "merge-sha" })).toThrow(UniqueRunError);
    expect(() => selectUniqueRun({ runs: [], sha: "merge-sha" })).toThrow(/since/);
  });

  it("sha omitted → throws (fail closed, KTD6)", () => {
    expect(() => selectUniqueRun({ runs: [], since: since() })).toThrow(/sha/);
  });

  it("fixture runs: only run 5001 matches actor + since + requested sha", () => {
    const r = selectUniqueRun({ runs: RUNS.runs, since: since(), actor: RUNS.actor, sha: RUNS.requestedSha });
    expect(r).toEqual({ id: 5001 });
  });

  // Ancestry: a `workflow_dispatch` run is stamped with the BRANCH TIP at
  // dispatch, not the merge sha it was dispatched FOR. So once any commit lands on
  // the base between the lane merging and its bar running, headSha !== mergeSha even
  // for the lane's own run. The run is still valid proof when the merge sha is an
  // ancestor of that tip. The caller supplies ancestry (precomputed boolean, or a
  // predicate); the function stays pure.
  describe("ancestry — head is the branch tip, not the merge sha", () => {
    it("a descendant run (headSha != sha, isDescendant true) → selected", () => {
      const r = selectUniqueRun({
        runs: [{ ...run(7, 5_000, "tip-after-other-merges"), isDescendant: true }],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
      });
      expect(r).toEqual({ id: 7 });
    });

    it("an unrelated run (headSha != sha, isDescendant false) → still refused", () => {
      const r = selectUniqueRun({
        runs: [{ ...run(8, 5_000, "unrelated-tip"), isDescendant: false }],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
      });
      expect(r).toEqual({ none: true });
    });

    it("accepts a caller-supplied isDescendant(sha, head) predicate", () => {
      const r = selectUniqueRun({
        runs: [run(9, 5_000, "tip-after-other-merges")],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
        isDescendant: (mergeSha, head) => mergeSha === "merge-sha" && head === "tip-after-other-merges",
      });
      expect(r).toEqual({ id: 9 });
    });

    it("actor + since still filter even when isDescendant is true", () => {
      const r = selectUniqueRun({
        runs: [{ ...run(10, 5_000, "tip-after-other-merges", "someone-else"), isDescendant: true }],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
      });
      expect(r).toEqual({ none: true });
    });

    it("a descendant run created before `since` is still filtered by the window", () => {
      const r = selectUniqueRun({
        runs: [{ ...run(11, -1_000, "tip-after-other-merges"), isDescendant: true }],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
      });
      expect(r).toEqual({ none: true });
    });

    it("two descendant runs by ME after `since` → ambiguous with both ids", () => {
      const r = selectUniqueRun({
        runs: [
          { ...run(12, 5_000, "tip-after-other-merges"), isDescendant: true },
          { ...run(13, 9_000, "another-descendant-tip"), isDescendant: true },
        ],
        since: since(),
        actor: "alice",
        sha: "merge-sha",
      });
      expect(r).toEqual({ ambiguous: [12, 13] });
    });
  });

  // Push mode (R7/KTD4): the run the base-branch push itself triggered. No actor —
  // GitHub, not the PM, started it — so the merge sha and the mergedAt − 60s
  // window are the ONLY discriminators, and the same rule decides.
  describe("push mode (no actor)", () => {
    const { since: PUSH_SINCE, runs: PUSH_RUNS, duplicate } = RUNS.push;
    const select = (runs) => selectUniqueRun({ runs, since: PUSH_SINCE, sha: RUNS.requestedSha });

    it("the one push run at the merge sha inside the window → its id", () => {
      expect(select(PUSH_RUNS)).toEqual({ id: 6001 });
    });

    it("only the push run at ANOTHER sha → none", () => {
      expect(select([PUSH_RUNS[1]])).toEqual({ none: true });
    });

    it("only a push run created before mergedAt − 60s → none", () => {
      expect(select([PUSH_RUNS[2]])).toEqual({ none: true });
    });

    it("two push runs at the merge sha → ambiguous, for the operator's --run-id", () => {
      expect(select([...PUSH_RUNS, duplicate])).toEqual({ ambiguous: [6001, 6004] });
    });
  });
});

// -----------------------------------------------------------------------
// The bar comes from CONFIG, never from the lane YAML (R7/R9, KTD4). Every case
// passes its config EXPLICITLY — postMergeBar has no DEFAULTS fallback, so a
// call site that forgets to thread the config fails loudly instead of quietly
// running another repo's bar.
describe("postMergeBar (R7/R9, KTD4)", () => {
  const preview = { kind: "preview" };
  const chore = { kind: "chore" };
  const withPreview = (patch) => {
    const c = structuredClone(FULL);
    Object.assign(c.postMergeBar.preview, patch);
    return c;
  };

  it("a chore lane on the full config → the configured dispatch workflow, one run", () => {
    expect(postMergeBar(chore, FULL)).toMatchObject({ mode: "dispatch", workflow: "unit.yml", runs: 1 });
  });

  it("a preview lane → the configured bar with ${sha} substituted into the inputs", () => {
    const cfg = FULL.postMergeBar.preview;
    const bar = postMergeBar(preview, FULL, { mergeSha: "merge1966" });
    expect(bar).toMatchObject({
      mode: "dispatch",
      workflow: cfg.workflow,
      runs: 1,
      retryMarker: cfg.retryMarker,
    });
    expect(bar.inputs).toEqual({ ...cfg.inputs, sha: "merge1966" });
  });

  it("a ${sha} placeholder with no merge sha throws rather than dispatching the literal", () => {
    expect(() => postMergeBar(preview, FULL)).toThrow(/merge sha/i);
  });

  it("dispatch mode: a lane RAISES the run count (lane 3 over config 1 → 3)", () => {
    expect(postMergeBar({ ...preview, postMergeRuns: 3 }, FULL, { mergeSha: "s" }).runs).toBe(3);
  });

  it("dispatch mode: a lane can never LOWER it (lane 1 under config 2 → 2)", () => {
    expect(postMergeBar({ ...preview, postMergeRuns: 1 }, withPreview({ runs: 2 }), { mergeSha: "s" }).runs).toBe(2);
  });

  it("dispatch mode: a lane above postMergeBar.maxRuns fails the lane contract", () => {
    expect(() => postMergeBar({ ...preview, postMergeRuns: 5 }, FULL, { mergeSha: "s" })).toThrow(LaneContractError);
    expect(() => postMergeBar({ ...preview, postMergeRuns: 5 }, FULL, { mergeSha: "s" })).toThrow(/maxRuns/);
  });

  it("push mode is exactly one run and ignores the lane's key", () => {
    const bar = postMergeBar({ ...preview, postMergeRuns: 3 }, CONSUMER, { mergeSha: "s" });
    expect(bar).toMatchObject({ mode: "push", workflow: "ci.yml", runs: 1 });
    expect(bar.inputs).toEqual({});
  });

  it("a config with no bar for the lane's kind throws rather than assuming one", () => {
    expect(() => postMergeBar(preview, {})).toThrow(/postMergeBar\.preview/);
  });
});

// -----------------------------------------------------------------------
// Only a run that CONCLUDES red may post base-regressed (R8); everything
// else that ends the bar without a verdict is could-not-run.
describe("barOutcome (R8)", () => {
  it("success verifies", () => {
    expect(barOutcome("success")).toBe("verified");
  });

  it.each(["failure", "timed_out"])("%s is red", (c) => {
    expect(barOutcome(c)).toBe("regressed");
  });

  // `null` is the conclusion of a run still queued/in progress when the bar
  // timeout expires, and "" is a run that vanished from the selection window.
  it.each(["cancelled", "skipped", "stale", "", null, undefined, "startup_failure"])(
    "%s is infra, never a regression",
    (c) => {
      expect(barOutcome(c)).toBe("infra");
    },
  );
});

// -----------------------------------------------------------------------
// The operator's --run-id re-entry bypasses selection but must still be the bar
// the lane owes: same workflow file, same commit (KTD4).
describe("barRunMismatch (KTD4)", () => {
  const bar = { workflow: "e2e.yml", mergeSha: "merge1966" };

  it("a run at the merge sha for the bar's workflow matches", () => {
    expect(barRunMismatch({ headSha: "merge1966", path: ".github/workflows/e2e.yml" }, bar)).toEqual([]);
  });

  it("a run at another sha is refused", () => {
    const r = barRunMismatch({ headSha: "other2222", path: ".github/workflows/e2e.yml" }, bar);
    expect(r.join(" ")).toMatch(/other2222/);
  });

  it("a run of another workflow is refused", () => {
    const r = barRunMismatch({ headSha: "merge1966", path: ".github/workflows/unit.yml" }, bar);
    expect(r.join(" ")).toMatch(/unit\.yml/);
  });

  it("a row carrying no workflow path fails closed", () => {
    expect(barRunMismatch({ headSha: "merge1966" }, bar).length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------
describe("nextAction", () => {
  it("returns the first non-closed lane's step as the next action", () => {
    const lanes = [
      { lane: "L1", state: "closed", step: "next" },
      { lane: "L2", state: "pushed", step: "babysit" },
    ];
    expect(nextAction(lanes)).toMatchObject({ lane: "L2", action: "babysit", state: "pushed" });
  });

  it("halts the whole queue on a base-regressed lane", () => {
    expect(nextAction([{ lane: "L3", state: "base-regressed", step: "halt" }])).toMatchObject({
      action: "halt",
      reason: "base-regressed",
    });
  });

  it("all lanes closed → campaign complete", () => {
    expect(nextAction([{ state: "closed" }, { state: "closed" }])).toEqual({ action: "campaign-complete" });
  });
});

// -----------------------------------------------------------------------
// Review-hardening cases (code-review findings, #1986 U7).
describe("review-hardening: untrusted-input guards", () => {
  it("rejects an allowed-paths entry that authorizes the whole repo (** — R23/KTD10)", () => {
    expect(() => parseLaneContract(laneBody({ ...validFields(), "allowed-paths": ["**"] }), { subIssue: 5 })).toThrow(
      /whole repo|all-authorizing/,
    );
  });

  it("rejects an unknown kind (untrusted YAML fail-closed)", () => {
    expect(() => parseLaneContract(laneBody({ ...validFields(), kind: "feat" }), { subIssue: 3 })).toThrow(/kind/);
    expect(() => parseLaneContract(laneBody({ ...validFields(), kind: "" }), { subIssue: 3 })).toThrow(LaneContractError);
  });

  it("rejects a missing or empty allowed-paths (the R23/scope field must exist)", () => {
    const noAp = validFields();
    delete noAp["allowed-paths"];
    expect(() => parseLaneContract(laneBody(noAp), { subIssue: 3 })).toThrow(/allowed-paths/);
    expect(() => parseLaneContract(laneBody({ ...validFields(), "allowed-paths": [] }), { subIssue: 3 })).toThrow(
      /allowed-paths/,
    );
  });

  it("orderLanes disambiguates multiple 'checklist' headings to the single 'Lane checklist'", () => {
    const body = "## Rollout checklist\n- [ ] #9\n\n## Lane checklist\n- [ ] #1\n- [ ] #2\n";
    expect(orderLanes(body, [{ number: 1 }, { number: 2 }]).map((s) => s.number)).toEqual([1, 2]);
  });

  it("orderLanes throws on an ambiguous epic with several 'checklist' headings and no 'Lane checklist'", () => {
    const body = "## Rollout checklist\n- [ ] #1\n\n## Deploy checklist\n- [ ] #2\n";
    expect(() => orderLanes(body, [{ number: 1 }, { number: 2 }])).toThrow(/ambiguous/);
  });

  it("orderLanes throws on a duplicate #N in the lane checklist", () => {
    expect(() => orderLanes("## Lane checklist\n- [ ] #1\n- [ ] #1\n", [{ number: 1 }])).toThrow(/duplicate/);
  });

  it("evaluateChecklist accepts scoped and script: commit prefixes; still rejects feat:", () => {
    const lane = { kind: "chore", plan: "docs/plans/x.md", allowedPaths: ["package.json"], subIssue: 2 };
    const base = { lane, files: ["package.json"], body: "Closes #2", policy: FULL.subjects };
    for (const s of ["chore(deps): bump x", "test(spine): add", "script: add helper", "docs(x): y"]) {
      expect(evaluateChecklist({ ...base, subjects: [`${s} [skip-cd]`] }).violations).not.toContain("subject-prefix");
    }
    expect(evaluateChecklist({ ...base, subjects: ["feat: x [skip-cd]"] }).violations).toContain("subject-prefix");
  });

  it("deriveLaneState maps each blocked posting to its attention step, over-riding PR facts", () => {
    expect(deriveLaneState({ posted: "blocked-infra" })).toEqual({ state: "blocked-infra", step: "escalate-infra" });
    expect(deriveLaneState({ posted: "blocked", pr: { state: "OPEN" } })).toEqual({ state: "blocked", step: "babysit" });
    expect(deriveLaneState({ posted: "blocked-scope" })).toEqual({ state: "blocked-scope", step: "checklist" });
  });

  it("deriveLaneState never treats a 'merged' posting as merged ('merged' is derived, not posted)", () => {
    const r = deriveLaneState({ posted: "merged", pr: null, roster: [], worktrees: [], workerName: "w1" });
    expect(r.step).not.toBe("post-merge-bar");
    expect(r.step).toBe("start-gate");
  });
});

// #2039: flag a hand-occupied lane branch (branch exists locally, no PR) so the
// spine orchestrator sees a cannibalized lane at `spine status` time instead of
// colliding at spawn. computeSpineStatus reads the injected `existingBranches`
// and stays pure. Cases inject `existingBranches` on a per-case structuredClone
// of the shared fixture — NEVER on the shared file itself (run.test.mjs asserts
// stepFor(1971)==='start-gate' against it and is out of this lane's allowed paths).
describe("computeSpineStatus branch-exists-no-pr caveat (#2039)", () => {
  const withBranches = (branches) => {
    const snap = structuredClone(EPIC);
    if (branches !== undefined) snap.existingBranches = branches;
    return snap;
  };
  const rowFor = (result, subIssue) => result.lanes.find((l) => l.subIssue === subIssue);

  it("flags a PR-less lane whose branch is in existingBranches (caveat + non-launchable step)", () => {
    const result = computeSpineStatus(withBranches(["fix-1971-leaf-majors"])); // L7, no PR in fixture
    const l7 = rowFor(result, 1971);
    expect(l7.pr).toBeNull();
    expect(l7.caveat).toBe("branch-exists-no-pr");
    expect(l7.step).toBe("branch-occupied"); // distinct, non-launchable
    expect(l7.step).not.toBe("start-gate");
    expect(l7.step).not.toBe("needs-roster");
  });

  it("leaves a PR-less lane untouched when its branch is NOT in existingBranches", () => {
    const result = computeSpineStatus(withBranches(["some-unrelated-branch"]));
    const l7 = rowFor(result, 1971);
    expect(l7.caveat).toBeNull();
    expect(l7.step).toBe("start-gate");
  });

  it("never flags a lane that already has a resolved PR, even if its branch exists (PR wins)", () => {
    const result = computeSpineStatus(withBranches(["fix-1968-typescript-6"])); // L3, PR open not green
    const l3 = rowFor(result, 1968);
    expect(l3.pr).not.toBeNull();
    expect(l3.caveat).toBeNull();
    expect(l3.step).toBe("babysit");
  });

  it("flags nothing when the snapshot carries no existingBranches field (graceful degradation)", () => {
    const result = computeSpineStatus(withBranches(undefined));
    expect(result.lanes.some((l) => l.caveat === "branch-exists-no-pr")).toBe(false);
    expect(rowFor(result, 1971).step).toBe("start-gate");
  });

  // A live worker creates its lane's branch (git worktree add -b) long before it
  // opens a PR — so a spawned/watch lane's branch always exists. That is the spine's
  // own in-flight work, NOT a hand-occupied collision; the flag must not clobber it.
  it("does not flag a lane a live worker is actively building (step stays watch)", () => {
    const snap = structuredClone(EPIC);
    snap.roster = [...snap.roster, { name: "w1971", agent_status: "working", pane_id: "w0:p9" }];
    snap.existingBranches = ["fix-1971-leaf-majors"]; // its branch exists because the worker made it
    const l7 = rowFor(computeSpineStatus(snap), 1971);
    expect(l7.pr).toBeNull();
    expect(l7.step).toBe("watch");
    expect(l7.caveat).toBeNull();
  });

  // The originating incident: `spine status <epic> --dry-run` with no roster/worktrees.
  // deriveLaneState degrades to needs-roster; the branch a hand-created worktree left
  // behind must still be flagged rather than reported as a clean queued lane.
  it("flags a no-roster (needs-roster) lane whose branch exists — the --dry-run cannibalization incident", () => {
    const snap = structuredClone(EPIC);
    delete snap.roster;
    delete snap.worktrees;
    snap.existingBranches = ["fix-1971-leaf-majors"];
    const l7 = rowFor(computeSpineStatus(snap), 1971);
    expect(l7.pr).toBeNull();
    expect(l7.step).toBe("branch-occupied");
    expect(l7.caveat).toBe("branch-exists-no-pr");
  });
});
