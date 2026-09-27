// Spine-mode pure logic for the multi-worker-pm skill.
//
// Data-in / data-out only — NO gh/herdr/git calls, NO file I/O, NO clock
// reads. run.mjs owns the edges and the shell scripts own the side effects
// (KTD2); every rule the spine applies lives here so it is testable under a
// frozen clock against plain fixtures.
//
// The per-repo FACTS those rules read — subject prefixes, the [skip-cd] policy,
// the preview status context, the repo owner, the expected authors — arrive as
// PARAMETERS; this module never loads them. It imports
// config.mjs only for DEFAULTS, which is what "no config file present" means
// (R1), and for the config file's own name, which is a protected path (KTD3).
//
// Trust model (KTD10): the epic body, sub-issue YAML, `state:` comments, and PR
// rows are all UNTRUSTED input. Nothing here interpolates them into a command;
// path fields are traversal-normalized (R25), state comments are authenticated
// by author (R21), the lane PR is bound to head-repo/branch/base/author (R22),
// and `allowed-paths` can never authorize the mode's own control files (R23).

import { CONFIG_FILENAME, DEFAULTS, subjectPrefixRegex } from "./config.mjs";
import { normalizePath, pathsOverlap } from "./select.mjs";

// Append-only posted state vocabulary (KTD4). `queued` is derived per the plan
// but the prototype posts it, so it is recognized on read; it is never a halt.
const POSTED_STATES = new Set([
  "queued",
  "spawned",
  "blocked-infra",
  "blocked",
  "blocked-scope",
  "base-verified",
  "chore-verified",
  "base-regressed",
  "closed",
]);

// Paths whose edit a lane must never authorize, independent of allowed-paths
// (R23) — the controls that constrain the mode. `.claude/` and `.agents/` hold
// agent settings, hooks and project-level skill installs (this skill included).
// The per-repo config file joins the list as an exact-file entry (KTD3): it
// carries the subject, green and identity rules the checklist itself applies, so
// a lane that could edit it could rewrite the rules that constrain it. A repo
// appends its own prefixes via config `protectedPaths`.
const PROTECTED_PREFIXES = [".claude/", ".agents/", ".github/workflows/", ".husky/", CONFIG_FILENAME];

// A Renovate-campaign lockfile-integrity floor (KTD11) — checked only when the
// caller supplies a count (i.e. package-lock.json changed on an opted-in lane).
const PARCEL_WATCHER_MIN = 13;

// --- Named, fail-closed errors -------------------------------------------

export class LaneContractError extends Error {
  constructor(message, { subIssue, field } = {}) {
    super(message);
    this.name = "LaneContractError";
    this.subIssue = subIssue;
    this.field = field;
  }
}

export class LaneOrderError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "LaneOrderError";
    Object.assign(this, extra);
  }
}

export class UniqueRunError extends Error {
  constructor(message) {
    super(message);
    this.name = "UniqueRunError";
  }
}

// --- Traversal-safe path handling (R25) ----------------------------------

const unquote = (s) => {
  const t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

// Path list entries in the YAML carry human annotations, e.g.
// `src/** (type-annotation-only fixes)`. The path is the first whitespace token;
// the annotation is discarded before validation and containment.
const pathToken = (entry) => unquote(entry).trim().split(/\s+/)[0] ?? "";

// Normalize, then reject anything that can escape the repo: absolute, backslash,
// `..`, or an empty segment. `**` glob segments are fine. The `^docs/plans/.*\.md$`
// shape check ALONE accepts traversal, so this runs first (R25).
function assertSafeRelPath(raw, ctx) {
  const token = pathToken(raw);
  if (token === "") throw new LaneContractError(`${ctxLabel(ctx)}: empty path in ${ctx.field}`, ctx);
  if (/\\/.test(token)) throw new LaneContractError(`${ctxLabel(ctx)}: backslash in path "${token}" (${ctx.field})`, ctx);
  if (token.startsWith("/")) throw new LaneContractError(`${ctxLabel(ctx)}: absolute path "${token}" (${ctx.field})`, ctx);
  const norm = normalizePath(token);
  const segs = norm.split("/");
  if (segs.some((s) => s === "" || s === "..")) {
    throw new LaneContractError(`${ctxLabel(ctx)}: path traversal in "${token}" (${ctx.field})`, ctx);
  }
  return norm;
}

const ctxLabel = ({ subIssue } = {}) => `sub-issue #${subIssue ?? "unknown"}`;

// --- Minimal YAML-subset parser ------------------------------------------
// The lane contract is a fixed shape: top-level `key: scalar` and `key:` lists
// of `  - item`. A dedicated parser keeps this module dependency-free (matches
// select.mjs) — ponytail: not js-yaml for eight known keys.
function parseSimpleYaml(text) {
  const out = {};
  let curKey = null;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && curKey) {
      (out[curKey] ||= []).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const [, key, val] = kv;
      if (val === "") {
        out[key] = [];
        curKey = key;
      } else if (/^\[[^\s"'(),]*(\s*,\s*[^\s"'(),]+)*\]$/.test(val)) {
        // Flow list `key: [a, b]` of bare tokens only Quoted or annotated items stay a string,
        // which parseLaneContract refuses: splitting `[x (a, b)]` on commas would mint a scope from an annotation.
        out[key] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
        curKey = null;
      } else {
        out[key] = unquote(val);
        curKey = null;
      }
    }
  }
  return out;
}

function extractYamlBlock(body) {
  const m = /```ya?ml\s*\n([\s\S]*?)\n```/i.exec(String(body ?? ""));
  return m ? m[1] : null;
}

/**
 * Parse a lane sub-issue body's fenced YAML contract into a validated lane.
 * `preview + operator` → { kind: "preview", operator: true }. Every path field
 * is traversal-checked (R25); a missing/unparseable field throws a named error
 * identifying the sub-issue and field.
 * @param {string} body       the sub-issue markdown body
 * @param {{subIssue?: number}} [opts]  context for error messages
 */
export function parseLaneContract(body, opts = {}) {
  const subIssue = typeof opts === "number" ? opts : opts?.subIssue;
  const yaml = extractYamlBlock(body);
  if (yaml == null) throw new LaneContractError(`${ctxLabel({ subIssue })}: no fenced yaml lane block`, { subIssue });
  const raw = parseSimpleYaml(yaml);

  const req = (field) => {
    const v = raw[field];
    if (v == null || (typeof v === "string" && v.trim() === "")) {
      throw new LaneContractError(`${ctxLabel({ subIssue })}: missing required field "${field}"`, { subIssue, field });
    }
    return v;
  };

  const planRaw = String(req("plan"));
  const plan = assertSafeRelPath(planRaw, { subIssue, field: "plan" });
  if (!plan.startsWith("docs/plans/") || !plan.endsWith(".md")) {
    throw new LaneContractError(`${ctxLabel({ subIssue })}: plan "${planRaw}" must be a canonical docs/plans/*.md path`, {
      subIssue,
      field: "plan",
    });
  }

  const lane = String(req("lane"));

  const kindRaw = String(req("kind")).trim();
  let kind;
  let operator = false;
  if (kindRaw === "preview + operator") {
    kind = "preview";
    operator = true;
  } else if (kindRaw === "preview" || kindRaw === "chore") {
    kind = kindRaw;
  } else {
    throw new LaneContractError(`${ctxLabel({ subIssue })}: unknown kind "${kindRaw}"`, { subIssue, field: "kind" });
  }

  const branch = String(req("branch"));
  if (!/^[a-z]+-\d+-[a-z0-9-]+$/.test(branch)) {
    throw new LaneContractError(`${ctxLabel({ subIssue })}: branch "${branch}" fails ^[a-z]+-\\d+-[a-z0-9-]+$`, {
      subIssue,
      field: "branch",
    });
  }

  // A list field left as a string is an unparsed list (`[a] # note`, `[x (a, b)]`) — refuse it rather than
  // let `packages` silently empty.
  for (const field of ["packages", "allowed-paths"]) {
    if (typeof raw[field] === "string") {
      throw new LaneContractError(`${ctxLabel({ subIssue })}: "${field}" must be a list of bare paths — use block form (\`- item\`)`, {
        subIssue,
        field,
      });
    }
  }
  const packages = Array.isArray(raw.packages) ? raw.packages.map(String) : [];

  const allowedRaw = raw["allowed-paths"];
  if (!Array.isArray(allowedRaw) || allowedRaw.length === 0) {
    throw new LaneContractError(`${ctxLabel({ subIssue })}: missing required field "allowed-paths"`, {
      subIssue,
      field: "allowed-paths",
    });
  }
  const allowedPaths = allowedRaw.map((p) => assertSafeRelPath(p, { subIssue, field: "allowed-paths" }));
  // A bare `**` normalizes away in isPathAllowed's `/?\*\*$` strip to "" → matches
  // every file, so an untrusted lane could authorize itself unbounded scope and the
  // `outside-allowed-paths` gate would never fire. An all-repo scope needs explicit
  // operator sign-off, not the lane's own declaration (R23/KTD10). `foo/**` (strips
  // to `foo`) stays fine.
  for (const ap of allowedPaths) {
    if (ap === "**" || ap.replace(/\/?\*\*$/, "") === "") {
      throw new LaneContractError(
        `${ctxLabel({ subIssue })}: allowed-paths entry "${ap}" authorizes the whole repo — an all-authorizing scope is refused (R23/KTD10)`,
        { subIssue, field: "allowed-paths" },
      );
    }
  }

  // The bar's workflow comes from the config's postMergeBar and nowhere else
  // (R9). These two keys used to let a lane name it; refusing them BY NAME turns
  // a silently-ignored leftover into a stop, because an untrusted lane body must
  // never be able to point the post-merge bar at a workflow of its choosing.
  for (const banned of ["verificationWorkflow", "choreWorkflow"]) {
    if (banned in raw) {
      throw new LaneContractError(
        `${ctxLabel({ subIssue })}: "${banned}" is not a lane field — the bar workflow comes from the config's postMergeBar only (R9)`,
        { subIssue, field: banned },
      );
    }
  }

  // A lane may RAISE the dispatch-mode run count, never lower it and never above
  // postMergeBar.maxRuns (R9) — the cap is applied in postMergeBar, which is the
  // one that holds the config.
  let postMergeRuns = null;
  const runsRaw = raw["post-merge-runs"];
  if (runsRaw != null && String(runsRaw).trim() !== "") {
    postMergeRuns = Number(String(runsRaw).trim());
    if (!Number.isInteger(postMergeRuns) || postMergeRuns < 1) {
      throw new LaneContractError(`${ctxLabel({ subIssue })}: post-merge-runs "${runsRaw}" must be a positive integer`, {
        subIssue,
        field: "post-merge-runs",
      });
    }
  }

  return { subIssue, lane, kind, operator, branch, plan, packages, allowedPaths, postMergeRuns };
}

// --- Lane ordering (R1) ---------------------------------------------------

// Numbers from the epic's lane checklist, in order. Scoped to a heading whose
// text contains "checklist" (the Lane checklist) so a separate "Deferred majors"
// checkbox list is never read as lanes; falls back to every checkbox line when
// no such heading exists.
function laneChecklistNumbers(epicBody) {
  const body = String(epicBody ?? "");
  // The epic body is untrusted (KTD10): scope to the section under a heading whose
  // text contains "checklist". When several do, disambiguate to the single "Lane
  // checklist" heading rather than silently taking the first, so a crafted earlier
  // "…checklist" section cannot drive lane order/subset. No such heading → whole body.
  const headings = [...body.matchAll(/^#{1,6}[ \t]+(.*checklist.*)$/gim)];
  let heading = null;
  if (headings.length > 1) {
    const lane = headings.filter((h) => /lane\s+checklist/i.test(h[1]));
    if (lane.length === 1) heading = lane[0];
    else
      throw new LaneOrderError("ambiguous lane checklist: multiple 'checklist' headings and no single 'Lane checklist'", {
        headings: headings.map((h) => h[1].trim()),
      });
  } else if (headings.length === 1) {
    heading = headings[0];
  }
  let scope = body;
  if (heading) {
    const rest = body.slice(heading.index + heading[0].length);
    const next = rest.search(/^#{1,6}[ \t]+/m);
    scope = next >= 0 ? rest.slice(0, next) : rest;
  }
  const nums = [];
  for (const line of scope.split("\n")) {
    const m = /^\s*-\s*\[[ xX]\]\s*#(\d+)\b/.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  return nums;
}

/**
 * Order lane sub-issues by the epic body checklist. The checklist set and the
 * sub-issue API set MUST be equal (R1); an extra or missing member throws.
 * @param {string} epicBody
 * @param {Array<{number:number}>} subIssues  the sub_issues API set
 * @returns {Array} the sub-issue objects in checklist order
 */
export function orderLanes(epicBody, subIssues) {
  const order = laneChecklistNumbers(epicBody);
  if (order.length === 0) throw new LaneOrderError("empty lane checklist in epic body");
  const api = (subIssues ?? []).map((s) => s.number);
  const orderSet = new Set(order);
  const apiSet = new Set(api);
  if (order.length !== orderSet.size) {
    throw new LaneOrderError("duplicate entries in the epic lane checklist", { checklist: order });
  }
  const missingFromApi = order.filter((n) => !apiSet.has(n));
  if (missingFromApi.length) {
    throw new LaneOrderError("epic lane checklist names sub-issues absent from the sub_issue API set", {
      checklistOnly: missingFromApi,
    });
  }
  // The lane checklist is authoritative for what runs. A real epic also attaches
  // NON-lane sub-issues — e.g. a "Deferred" list under a separate heading — so
  // the API set is a SUPERSET of the lanes, not equal to them. API-only sub-issues are
  // ignored, not an error.
  const byNumber = new Map((subIssues ?? []).map((s) => [s.number, s]));
  return order.map((n) => byNumber.get(n));
}

// --- Lane PR identity binding (R22) --------------------------------------

// `owner` is the org from the primary's `gh repo view --json nameWithOwner`
// (R11) — never a literal. Unknown (the read soft-failed): GitHub's own
// isCrossRepository flag still carries the check on its own.
const isFork = (pr, owner) =>
  pr?.isCrossRepository === true || (owner != null && pr?.headRepositoryOwner?.login != null && pr.headRepositoryOwner.login !== owner);

/**
 * Resolve the one identity-bound PR for a lane, or a refusal reason (R22). The
 * PR's head repo must be this repo (not a fork), its head branch the lane
 * branch, its base the configured base branch, and its author an expected login. Zero, multiple,
 * fork, wrong-base, or unexpected-author → refused, never resolved.
 * @param {Array} prs
 * @param {{branch:string}} lane
 * @param {string|string[]} expectedAuthor  identity.expectedAuthors
 * @param {{owner?:string|null, baseBranch?:string}} [opts]  the repo owner from the primary (R11), config baseBranch
 * @returns {{pr:object}|{refused:true, reason:string}}
 */
export function resolveLanePr(prs, lane, expectedAuthor, { owner = null, baseBranch = DEFAULTS.baseBranch } = {}) {
  const branch = lane?.branch;
  if (!branch) return { refused: true, reason: "lane-missing-branch" };
  const authors = new Set((Array.isArray(expectedAuthor) ? expectedAuthor : [expectedAuthor]).filter(Boolean));
  const byBranch = (prs ?? []).filter((p) => p.headRefName === branch);
  if (byBranch.length === 0) return { refused: true, reason: "no-pr" };

  const passing = [];
  const reasons = new Set();
  for (const p of byBranch) {
    const problems = [];
    if (isFork(p, owner)) problems.push("fork-head");
    if (p.baseRefName !== baseBranch) problems.push("wrong-base");
    if (!authors.has(p.author?.login)) problems.push("unexpected-author");
    if (problems.length === 0) passing.push(p);
    else problems.forEach((r) => reasons.add(r));
  }
  if (passing.length === 1) return { pr: passing[0] };
  if (passing.length > 1) return { refused: true, reason: "multiple" };
  return { refused: true, reason: [...reasons].join(",") || "refused" };
}

// --- State-comment authentication (R21) ----------------------------------

const commentAuthor = (c) => c?.author?.login ?? c?.user?.login ?? (typeof c?.author === "string" ? c.author : null);

const loginSet = (identity) =>
  new Set((Array.isArray(identity) ? identity : [identity]).map((i) => (typeof i === "string" ? i : i?.login)).filter(Boolean));

/**
 * A `state:` comment is authoritative only when authored by one of the
 * configured automation identities (R21/R10). Any other author is ignored and
 * flagged, so an issue commenter cannot post `base-verified`/`closed` to
 * advance a lane.
 * @param {{body?:string, author?:object|string}} comment
 * @param {string|string[]|{login:string}} identity  identity.expectedAuthors
 */
export function authenticateStateComment(comment, identity) {
  const expected = loginSet(identity);
  const m = /(?:^|\n)\s*state:\s*([a-z][a-z-]*)/i.exec(comment?.body ?? "");
  if (!m) return { authentic: false, flagged: true, reason: "not-a-state-comment" };
  const state = m[1].toLowerCase();
  const author = commentAuthor(comment);
  if (!expected.has(author)) return { authentic: false, flagged: true, reason: "untrusted-author", author };
  if (!POSTED_STATES.has(state)) return { authentic: false, flagged: true, reason: "unrecognized-state", state };
  const shaMatch = /\b([0-9a-f]{7,40})\b/i.exec(comment?.body ?? "");
  return { authentic: true, state, sha: shaMatch ? shaMatch[1] : null };
}

/**
 * The last authenticated posted state across a comment thread (R21), or null.
 * Convenience for callers deriving lane state from a comment list.
 */
export function latestAuthenticatedState(comments, identity) {
  let last = null;
  for (const c of comments ?? []) {
    const auth = authenticateStateComment(c, identity);
    if (auth.authentic) last = auth;
  }
  return last;
}

// --- Lane state derivation (R16, KTD4) -----------------------------------

// `previewContext` is checks.previewContext from the config: a repo with no
// preview status context (null) proves a preview lane on the required checks
// alone (R6/KTD5).
function isGreen(checks = {}, kind, previewContext = DEFAULTS.checks.previewContext) {
  const clean = String(checks.mergeStateStatus ?? "").toUpperCase() === "CLEAN";
  const required = checks.requiredChecksGreen === true;
  if (kind === "chore" || previewContext == null) return clean && required;
  return clean && required && String(checks.previewReport ?? "").toUpperCase() === "SUCCESS";
}

/**
 * Derive a lane's current state and its resume re-entry step (R16). A pure
 * function of the last authenticated posted state, the resolved lane PR, its
 * checks, and the live roster/worktrees. When the roster and worktrees are
 * absent (a gh-only status, R4/R16), live-worker states are unavailable: it
 * reports the last authenticated posted state with a caveat and NEVER derives
 * `spawned`/watch, so a bare status cannot invite a double-spawn.
 * @param {object} inputs
 * @param {{kind?:string}} [inputs.lane]
 * @param {string|{state:string, sha?:string|null}|null} [inputs.posted]  last AUTHENTICATED posted
 *   state; its `sha` (the commit the posting recorded) binds a `blocked-infra` to the merge commit
 * @param {object|null} [inputs.pr]     resolved lane PR ({state:"OPEN"|"MERGED"}) or null
 * @param {object} [inputs.checks]      {previewReport, requiredChecksGreen, mergeStateStatus}
 * @param {Array|null} [inputs.roster]  herdr agent list ([{name,agent_status}]); null/undefined = not supplied
 * @param {Array|null} [inputs.worktrees]  git worktree list; null/undefined = not supplied
 * @param {string} [inputs.workerName]  "w<sub>"
 * @param {string|null} [inputs.previewContext]  checks.previewContext; null drops the requirement
 * @returns {{state:string, step:string, caveat?:string}}
 */
export function deriveLaneState(inputs = {}) {
  const { lane, pr = null, checks = {}, roster, worktrees, workerName, previewContext } = inputs;
  const posted = typeof inputs.posted === "string" ? inputs.posted : inputs.posted?.state ?? null;
  const kind = lane?.kind;

  // Halt / terminal postings win regardless of live facts.
  if (posted === "base-regressed") return { state: "base-regressed", step: "halt" };
  if (posted === "closed") return { state: "closed", step: "next" };
  if (posted === "base-verified" || posted === "chore-verified") return { state: posted, step: "close" };

  // A bar that could not run posts `blocked-infra <merge-sha>` (R8), and resume
  // must not re-run it. That posting beats the MERGED PR — but ONLY when it is
  // bound to this merge commit: a lane blocked and recovered BEFORE its merge
  // still owes its bar, so an unbound (or differently-bound) blocked-infra falls
  // through to `post-merge-bar` exactly as it did before (KTD4).
  const prState = pr?.state ?? null;
  const postedSha = typeof inputs.posted === "string" ? null : inputs.posted?.sha ?? null;
  const mergeOid = pr?.mergeCommit?.oid ?? null;
  const barBlockedAtMerge =
    posted === "blocked-infra" && postedSha != null && mergeOid != null && mergeOid.toLowerCase().startsWith(postedSha.toLowerCase());
  if (barBlockedAtMerge) return { state: "blocked-infra", step: "escalate-infra" };

  // `merged` is a DERIVED state read from the PR (KTD4), never a posted one, so it
  // comes only from the PR state — POSTED_STATES has no `merged`.
  if (prState === "MERGED") return { state: "merged", step: "post-merge-bar" };

  // Blocked postings map to their attention steps; the posting is authoritative
  // about being blocked, so we don't silently override it from PR facts.
  if (posted === "blocked-infra") return { state: "blocked-infra", step: "escalate-infra" };
  if (posted === "blocked") return { state: "blocked", step: "babysit" };
  if (posted === "blocked-scope") return { state: "blocked-scope", step: "checklist" };

  if (prState === "OPEN") {
    return isGreen(checks, kind, previewContext)
      ? { state: "preview-green", step: "checklist" }
      : { state: "pushed", step: "babysit" };
  }

  // No PR. The roster tells us whether a worker is live.
  const rosterSupplied = roster != null && worktrees != null;
  if (!rosterSupplied) {
    return {
      state: posted ?? "queued",
      step: "needs-roster",
      caveat: "roster not supplied; live-worker states unavailable",
    };
  }
  const live = (roster ?? []).find((a) => a.name === workerName);
  if (live && ["working", "spawned", "idle", "blocked", "done"].includes(live.agent_status)) {
    return { state: "spawned", step: "watch" };
  }
  return { state: "queued", step: "start-gate" };
}

// --- Start gate (R6) -----------------------------------------------------

/**
 * Evaluate the spawn start gate (R6). Every failing reason is reported together
 * (not first-only).
 * @param {object} inputs
 * @param {string} inputs.primaryHead
 * @param {string} inputs.originBase      origin/<baseBranch>
 * @param {{verified:boolean}} inputs.predecessor  first lane passes {verified:true} for Gate 0
 * @param {string} inputs.identityLogin   the PM session's own gh login
 * @param {string[]} inputs.expectedAuthors  identity.expectedAuthors from the config
 * @param {boolean} inputs.configDirty    the KTD3/KTD7 control paths have uncommitted changes
 * @param {string} inputs.configDigest    the primary's config digest
 * @param {string} [inputs.lastSpawnedDigest]  `config=` on the campaign's last `spawned` comment
 * @param {string} [inputs.acceptedDigest]     `--accept-config <sha12>`
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function evaluateStartGate(inputs = {}) {
  const {
    primaryHead,
    originBase,
    predecessor,
    identityLogin,
    expectedAuthors,
    configDirty,
    configDigest,
    lastSpawnedDigest,
    acceptedDigest,
  } = inputs;
  const reasons = [];

  if (primaryHead == null || originBase == null || primaryHead !== originBase) reasons.push("primary-behind");

  const verified = predecessor?.verified === true;
  if (!verified) reasons.push("predecessor-unverified");

  // R10/KTD6: the login that will author this campaign's `state:` comments and
  // lane PRs must be one the config expects. No author list or no resolved login
  // refuses too — an unchecked identity is exactly what this gate exists to catch.
  if (!Array.isArray(expectedAuthors) || !expectedAuthors.includes(identityLogin)) reasons.push("identity-unexpected");

  // KTD3: the config and the skill it configures must be committed (an operator
  // mid-edit, or a skill update landing under a running campaign, would change
  // the rules the lanes are already being judged by)…
  if (configDirty) reasons.push("config-dirty");
  // …and must still be the config this campaign spawned under. A committed change
  // fast-forwarded into the primary is clean yet changes the rules mid-campaign;
  // `--accept-config <the primary's digest>` is the operator's explicit adoption.
  if (lastSpawnedDigest != null && lastSpawnedDigest !== configDigest && acceptedDigest !== configDigest) reasons.push("config-drift");

  return { ok: reasons.length === 0, reasons };
}

// --- Pre-merge checklist (R10, R23, KTD11) -------------------------------

// A protected entry is a prefix at segment boundaries: "ops/" and "ops" both
// protect "ops/a" but not "opsx/a". pathsOverlap normalizes "./" and "//" too.
const isProtectedPath = (f, extra = []) => pathsOverlap([f], [...PROTECTED_PREFIXES, ...extra]);

// File F is inside the allowed set when it is contained by one allowed pattern.
// A trailing `/**` (or a bare `**`) is stripped so pathsOverlap's segment
// containment (reused from select.mjs) covers everything under that prefix.
function isPathAllowed(file, allowedPaths) {
  const f = normalizePath(file);
  return (allowedPaths ?? []).some((raw) => {
    const stripped = normalizePath(String(raw).replace(/\/?\*\*$/, ""));
    if (stripped === "" || stripped === "**") return true;
    return f === stripped || pathsOverlap([f], [stripped]);
  });
}

/**
 * Evaluate the GitHub-record pre-merge checklist (R10). Returns every violation,
 * not the first. The R23 protected-path boundary is checked independently of
 * allowed-paths.
 * @param {object} inputs
 * @param {{kind:string, plan:string, allowedPaths:string[], subIssue:number}} inputs.lane
 * @param {string[]} inputs.subjects   commit subjects
 * @param {string[]} inputs.files      changed paths
 * @param {string} inputs.body         PR body
 * @param {number|null} [inputs.parcelWatcherCount]  @parcel/watcher count when package-lock changed on an opted-in lane
 * @param {{refused?:boolean}} [inputs.prResolution]  optional R22 resolution to fold in
 * @param {object} [inputs.policy]  config `subjects`: {<kind>: {prefixes, skipCd}} (defaults to DEFAULTS)
 * @param {string[]} [inputs.protectedPaths]  config `protectedPaths`, appended to PROTECTED_PREFIXES
 * @returns {{ok:boolean, violations:string[]}}
 */
export function evaluateChecklist(inputs = {}) {
  const {
    lane = {}, subjects = [], files = [], body = "", parcelWatcherCount = null, prResolution,
    policy = DEFAULTS.subjects, protectedPaths = [],
  } = inputs;
  const violations = [];
  const add = (v) => {
    if (!violations.includes(v)) violations.push(v);
  };

  if (prResolution?.refused) add("pr-identity");

  const kind = lane.kind;
  // Subject rules come from config (R2/KTD2): the loader supplies literal prefix
  // tokens and the regex is built here, so no repo can inject one. `skipCd` drives
  // both tag violations — `ignored` is a repo with no [skip-cd] convention at all.
  const rules = policy[kind] ?? policy.preview;
  const prefixRe = subjectPrefixRegex(rules.prefixes);
  for (const s of subjects) {
    const subject = String(s ?? "");
    const hasSkipCd = /\[skip-cd\]/.test(subject);
    if (rules.skipCd === "forbidden" && hasSkipCd) add("skip-cd-on-preview");
    if (rules.skipCd === "required" && !hasSkipCd) add("skip-cd-missing");
    if (!prefixRe.test(subject.trim())) add("subject-prefix");
  }

  const planNorm = lane.plan ? normalizePath(lane.plan) : null;
  // The acceptance gate writes ONE Gherkin artifact per plan as a `.feature` sibling of the
  // plan file, so a normal lane carries two docs/plans/ files. That sibling is the lane's own
  // artifact — only a plan belonging to someone else is foreign.
  const planFeature = planNorm ? planNorm.replace(/\.md$/, ".feature") : null;
  for (const raw of files) {
    const f = normalizePath(raw);
    if (isProtectedPath(f, protectedPaths)) add("protected-path");
    if (f.startsWith("docs/plans/") && f !== planNorm && f !== planFeature) add("foreign-plan");
    if (!isPathAllowed(f, lane.allowedPaths)) add("outside-allowed-paths");
  }

  if (lane.subIssue != null && !new RegExp(`clos(?:e|es|ed)\\s+#${lane.subIssue}\\b`, "i").test(String(body))) {
    add("closes-missing");
  }

  if (parcelWatcherCount != null && Number(parcelWatcherCount) < PARCEL_WATCHER_MIN) add("parcel-watcher-count");

  return { ok: violations.length === 0, violations };
}

// --- Unique workflow-run selection (R13, KTD6) ---------------------------

const asMs = (t) => (typeof t === "number" ? t : Date.parse(t));
const runActor = (r) => r?.actor?.login ?? r?.login ?? r?.user?.login ?? null;
const runId = (r) => r?.databaseId ?? r?.id;

/**
 * Select the unique workflow run for a dispatch (R13). Filters on actor,
 * `createdAt >= since`, AND head-matches the requested commit — a same-actor
 * dispatch of a different commit must never certify the lane. `since` or `sha`
 * missing throws (fail closed, KTD6): no wall-clock default.
 *
 * Head-match is NOT bare `headSha === sha`. A `workflow_dispatch` run is
 * stamped with the branch tip at dispatch, not the merge sha it was dispatched
 * FOR (which is only an `inputs.sha`), so once any commit lands on the base
 * between the lane merging and its bar running, the run's headSha is a descendant
 * of the merge sha rather than equal to it. A run head-matches when it equals the
 * merge sha OR the merge sha is an ancestor of it. Ancestry needs git, so the CALLER supplies it,
 * keeping this function pure: either each run carries a precomputed boolean
 * `isDescendant`, or an `isDescendant(sha, headSha)` predicate is passed. The
 * `actor` + `since` filters are unchanged — they, not ancestry, are what stop a
 * DIFFERENT run being adopted, and ancestry alone would be too loose without them.
 * @param {object} args
 * @param {Array} args.runs
 * @param {number|string} args.since  captured before the dispatch (T)
 * @param {string} [args.actor]       ME
 * @param {string} args.sha           the requested (merged) commit
 * @param {(sha:string, headSha:string)=>boolean} [args.isDescendant]  ancestry, from the caller
 * @returns {{id:*}|{ambiguous:*[]}|{none:true}}
 */
export function selectUniqueRun({ runs, since, actor, sha, isDescendant } = {}) {
  if (since == null) throw new UniqueRunError("selectUniqueRun requires `since` (capture T before dispatch)");
  if (sha == null) throw new UniqueRunError("selectUniqueRun requires `sha` (the requested commit)");
  const sinceMs = asMs(since);
  if (!Number.isFinite(sinceMs)) throw new UniqueRunError(`selectUniqueRun: unparseable since "${since}"`);

  // Equal merge sha is the base case (and the only one when no ancestry info is
  // supplied — preserving the old behavior). Otherwise a descendant run matches,
  // by the caller's precomputed boolean or predicate.
  const headMatches = (r) => {
    if (r.headSha === sha) return true;
    if (typeof r.isDescendant === "boolean") return r.isDescendant;
    if (typeof isDescendant === "function") return isDescendant(sha, r.headSha);
    return false;
  };

  const matches = (runs ?? []).filter((r) => {
    if (actor != null && runActor(r) !== actor) return false;
    const created = asMs(r.createdAt);
    if (!Number.isFinite(created) || created < sinceMs) return false;
    return headMatches(r);
  });
  const ids = matches.map(runId);
  if (ids.length === 1) return { id: ids[0] };
  if (ids.length > 1) return { ambiguous: ids };
  return { none: true };
}

// --- Post-merge bar and next action --------------------------------------

/**
 * Resolve the lane's post-merge bar from CONFIG (R7/R9, KTD4). The lane
 * contributes its kind and, in dispatch mode only, an optional raise of the run
 * count; the workflow, the inputs and the mode are the repo's, never the lane's.
 *
 * `config` is REQUIRED and has no default: a call site that forgets to thread it
 * must fail loudly rather than quietly run some other repo's bar.
 * @param {{kind?:string, postMergeRuns?:number|null}} lane
 * @param {{postMergeBar:object}} config    the loaded per-repo config
 * @param {{mergeSha?:string}} [opts]       substituted for the `${sha}` placeholder
 * @returns {{mode:string, workflow:string, runs:number, inputs:object, retryMarker:string|null}}
 */
export function postMergeBar(lane = {}, config, { mergeSha } = {}) {
  const kind = lane?.kind === "chore" ? "chore" : "preview";
  const bar = config?.postMergeBar?.[kind];
  if (!bar) throw new Error(`postMergeBar: config has no postMergeBar.${kind} — the bar is configuration, not a default`);

  // Push mode is ALWAYS one run: the base-branch push triggered exactly one, and
  // nothing can dispatch a second. The lane's raise applies to dispatch only.
  let runs = 1;
  if (bar.mode === "dispatch") {
    runs = bar.runs;
    if (lane.postMergeRuns != null) {
      const cap = config.postMergeBar.maxRuns;
      if (lane.postMergeRuns > cap) {
        throw new LaneContractError(
          `${ctxLabel(lane)}: post-merge-runs ${lane.postMergeRuns} exceeds postMergeBar.maxRuns ${cap} (R9)`,
          { subIssue: lane.subIssue, field: "post-merge-runs" },
        );
      }
      runs = Math.max(bar.runs, lane.postMergeRuns);
    }
  }

  // `${sha}` is the only placeholder the config may carry (KTD2). Dispatching it
  // unsubstituted would bind the bar to a literal, so a missing sha stops here.
  const inputs = {};
  for (const [k, v] of Object.entries(bar.inputs ?? {})) {
    if (v === "${sha}") {
      if (!mergeSha) throw new Error(`postMergeBar: input "${k}" needs the merge sha and none was supplied`);
      inputs[k] = mergeSha;
    } else {
      inputs[k] = v;
    }
  }

  return {
    mode: bar.mode,
    workflow: bar.workflow,
    runs,
    inputs,
    retryMarker: bar.retryMarker ?? null,
  };
}

/**
 * Map a bar run's conclusion to what the lane may post (R8). Only a run that
 * CONCLUDES red is a regression; everything else that ends the bar without a
 * verdict — cancelled, skipped, stale, no run in the window, or still running at
 * `postMergeBar.timeoutMinutes` (conclusion still null) — is could-not-run, and
 * halts the lane for an operator instead of halting the whole queue.
 * @param {string|null|undefined} conclusion
 * @returns {"verified"|"regressed"|"infra"}
 */
export function barOutcome(conclusion) {
  const c = String(conclusion ?? "").toLowerCase();
  if (c === "success") return "verified";
  if (c === "failure" || c === "timed_out") return "regressed";
  return "infra";
}

// `gh run view --json path` gives the workflow FILE (".github/workflows/x.yml");
// workflowName gives its display name. The bar names the file, so prefer path.
const runWorkflowFile = (run) => {
  const p = run?.path ?? run?.workflowPath ?? null;
  return p ? String(p).split("/").pop() : run?.workflowName ?? null;
};

/**
 * Why the operator's `--run-id` is NOT the bar the lane owes — empty when it is
 * (KTD4). `--run-id` bypasses run SELECTION, never the binding that makes a run
 * attributable: same workflow file, same commit. Fails closed on a row that
 * carries no workflow at all.
 * @param {{headSha?:string, path?:string, workflowName?:string}} run
 * @param {{workflow:string, mergeSha:string}} bar
 * @returns {string[]}  reasons; [] means the run may be used
 */
export function barRunMismatch(run, { workflow, mergeSha } = {}) {
  const reasons = [];
  const file = runWorkflowFile(run);
  if (!file) reasons.push("run carries no workflow path or name — cannot verify it is the bar's workflow");
  else if (workflow && file !== workflow) reasons.push(`run workflow ${file} is not the bar's workflow ${workflow}`);
  const head = String(run?.headSha ?? "");
  if (!head || head !== String(mergeSha ?? "")) reasons.push(`run headSha ${head || "(none)"} is not the merge commit ${mergeSha}`);
  return reasons;
}

/**
 * The campaign's next action: the first lane not `closed` in order, at the step
 * its derived state implies. A `base-regressed` lane halts the whole queue.
 * All lanes closed → campaign complete.
 * @param {Array} lanes  ordered lanes carrying {state, step} (or {derived:{state,step}})
 */
export function nextAction(lanes) {
  for (const lane of lanes ?? []) {
    const st = lane.derived ?? lane;
    const label = lane.lane ?? lane.subIssue ?? st.lane ?? null;
    if (st.state === "base-regressed") return { lane: label, action: "halt", reason: "base-regressed" };
    if (st.state !== "closed") return { lane: label, action: st.step, state: st.state, caveat: st.caveat };
  }
  return { action: "campaign-complete" };
}
