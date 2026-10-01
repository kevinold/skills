// Issue selection for the ko-multi-worker-pm skill.
//
// Pure functions only — no gh calls, no file I/O (run.mjs owns the edges).
// Selection is a safety mechanism, not just ranking: parallel workers on
// overlapping files break the base branch semantically even when both PRs are green,
// so overlap exclusion and the degraded-candidate cap are load-bearing.
//
// Label matching is exact-equality on purpose — never prefix matching.

// Lower rank = spawned first. autofix-candidate / agent-ready are the
// strongest low-effort signals (mirrors /whats-next).
const EFFORT_RANK = new Map([
  ["autofix-candidate", 0],
  ["agent-ready", 0],
  ["scope:mini", 1],
  ["scope:small", 2],
]);

// Derived, not restated: eligibility and ranking share one label vocabulary.
const POSITIVE_LABELS = new Set(EFFORT_RANK.keys());

// A label whose presence alone marks an issue out of autonomous scope.
const DANGER_LABELS = new Set(["ops", "production", "prod", "secrets", "security", "infra"]);

// Agent-lifecycle labels that mean "another agent already owns this". Their presence excludes the issue/PR from selection so concurrent
// multi-worker-pm runs don't double-work one item. agent-ready is deliberately
// NOT here — it stays claimable. Exact-equality set membership, never prefix
// (same rule as POSITIVE_LABELS / DANGER_LABELS). This is the source of truth,
// kept in sync BY HAND with the grep alternation in set-agent-label.sh; the
// drift guard in select.test.mjs fails if the copies diverge.
const IN_FLIGHT_AGENT_LABELS = new Set(["agent-in-progress", "agent-in-review", "agent-merged", "agent-blocked"]);

// ponytail: keyword vocabulary is a tunable starting set; the tests pin the
// classifier's shape (deterministic, URL-blind, path-aware, label-aware), not
// its final wording.
const DANGER_TEXT = new RegExp(
  [
    /\b(rotate|rotating|revoke|leaked?|exposed?)\b[^.\n]{0,40}\b(secrets?|credentials?|tokens?|keys?)\b/.source,
    /\bsecrets?\s+(manager|rotation)\b/.source,
    /\biam\s+(role|polic)/.source,
  ].join("|"),
  "i",
);
const DANGER_OPS = /\b(sandbox\s+delete|delete\s+the\s+sandbox|production\s+deploy|force[- ]push|branch\s+protection)\b/i;
// Generic path prefixes and credential filenames that are out of autonomous
// scope; a repo appends its own prefixes via config `dangerPaths`. The filename
// patterns match a bare basename (no slash) too, so a root credential file named
// in an issue body is caught even when it has no path.
const DANGER_PATHS = [
  /^\.github\/workflows\//,
  /^\.husky\//,
  /^\.claude\//,
  /^\.agents\//,
  /(^|\/)\.env/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)[^/]*(secret|credential|token)[^/]*$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
];

const stripUrls = (text) => (text ?? "").replace(/https?:\/\/\S+/g, " ");

// Canonicalize a repo-relative path so overlap and danger checks compare the
// same shape: POSIX separators, no leading "./", no trailing slash. Without
// this, "./src/a.ts" and "src/a.ts" read as disjoint and two workers edit one
// file.
export function normalizePath(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

export function classifyDangerScope({ title, body, expectedFiles, labels }, dangerPaths = []) {
  if ((labels ?? []).some((l) => DANGER_LABELS.has(l))) return true;
  const text = stripUrls(`${title ?? ""}\n${body ?? ""}`);
  if (DANGER_TEXT.test(text) || DANGER_OPS.test(text)) return true;
  if (pathsOverlap(expectedFiles, dangerPaths)) return true;
  return (expectedFiles ?? []).some((p) => {
    const np = normalizePath(p);
    return DANGER_PATHS.some((re) => re.test(np));
  });
}

// Prefix containment at path-segment boundaries: "src/foo" contains
// "src/foo/a.ts" but not "src/foobar/a.ts". Both sides are normalized first.
const segmentPrefix = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function pathsOverlap(pathsA, pathsB) {
  const a = (pathsA ?? []).map(normalizePath);
  const b = (pathsB ?? []).map(normalizePath);
  return a.some((x) => b.some((y) => segmentPrefix(x, y)));
}

const effortOf = (labels) => Math.min(...labels.filter((l) => EFFORT_RANK.has(l)).map((l) => EFFORT_RANK.get(l)));

const isClaimed = (issue, openPRs) => {
  if ((issue.assignees ?? []).length > 0) return true;
  const refRe = new RegExp(`(^|[^0-9])#${issue.number}([^0-9]|$)`);
  // Boundary on -, _, or / so slash-style branches (fix/42-auth) still claim.
  const branchRe = new RegExp(`(?:^|[-_/])${issue.number}(?=$|[-_/])`);
  return openPRs.some((pr) => refRe.test(`${pr.title ?? ""}\n${pr.body ?? ""}`) || branchRe.test(pr.headRefName ?? ""));
};

// Non-finite or negative caps fail closed to the R3 hard default (3), so a
// malformed --cap can never disable the resource-safety limit.
const safeCap = (cap) => (Number.isFinite(cap) && cap >= 0 ? Math.min(cap, 3) : 3);

/**
 * @param {object} args
 * @param {Array} args.issues     [{number, title, body, labels, assignees, expectedFiles|null}]
 * @param {Array} args.openPRs    [{number, title, body, headRefName}]
 * @param {Array} args.inFlight   [{issue, files|null, degraded}]
 * @param {number} args.cap       max TOTAL workers (in-flight + newly selected); hard-capped at 3 (R3)
 * @param {string|null} args.filter  optional extra label the issue must carry
 * @param {string[]} [args.dangerPaths]  config `dangerPaths`, appended to DANGER_PATHS
 * @returns {{selected: Array, backlog: Array, excluded: Array, deferred: number, drain: boolean}}
 */
export function selectIssues({ issues, openPRs = [], inFlight = [], cap = 3, filter = null, dangerPaths = [] }) {
  const excluded = [];
  const candidates = [];

  for (const issue of issues) {
    const labels = issue.labels ?? [];
    if (labels.includes("needs-human")) {
      excluded.push({ number: issue.number, reason: "needs-human" });
      continue;
    }
    // Before the positive-label check: a claimed issue has lost agent-ready, so
    // it carries no positive label and would otherwise be excluded as "label".
    if (labels.some((l) => IN_FLIGHT_AGENT_LABELS.has(l))) {
      excluded.push({ number: issue.number, reason: "claimed-by-agent" });
      continue;
    }
    if (!labels.some((l) => POSITIVE_LABELS.has(l))) {
      excluded.push({ number: issue.number, reason: "label" });
      continue;
    }
    if (filter && !labels.includes(filter)) {
      excluded.push({ number: issue.number, reason: "filter" });
      continue;
    }
    if (classifyDangerScope({ ...issue, labels }, dangerPaths)) {
      excluded.push({ number: issue.number, reason: "prod-ops-secrets" });
      continue;
    }
    if (isClaimed(issue, openPRs)) {
      excluded.push({ number: issue.number, reason: "claimed" });
      continue;
    }
    const files = (issue.expectedFiles ?? []).map(normalizePath);
    candidates.push({
      number: issue.number,
      title: issue.title,
      files,
      degraded: files.length === 0,
      effort: effortOf(labels),
    });
  }

  candidates.sort((a, b) => a.effort - b.effort || a.number - b.number);

  // The cap bounds the TOTAL roster, so the budget for this batch subtracts
  // the workers already in flight (R3 — otherwise backfill grows the pool
  // past the cap).
  const budget = Math.max(0, safeCap(cap) - inFlight.length);

  const selected = [];
  const backlog = [];
  const reserved = inFlight.flatMap((w) => (w.files ?? []).map(normalizePath));
  // An unknown file set overlaps every other unknown (R8): one degraded
  // worker at a time, in flight or in the batch.
  let degradedSlotUsed = inFlight.some((w) => w.degraded);

  for (const cand of candidates) {
    if (selected.length >= budget) {
      backlog.push(cand);
      continue;
    }
    if (cand.degraded) {
      if (degradedSlotUsed) {
        excluded.push({ number: cand.number, reason: "degraded-cap" });
        continue;
      }
      degradedSlotUsed = true;
      selected.push(cand);
      continue;
    }
    if (pathsOverlap(cand.files, reserved)) {
      excluded.push({ number: cand.number, reason: "overlap" });
      continue;
    }
    reserved.push(...cand.files);
    selected.push(cand);
  }

  // overlap / degraded-cap exclusions are transient — they clear when an
  // in-flight (or just-selected) blocker reclaims — so they must NOT end the
  // run. drain fires only when nothing spawnable remains for any reason.
  const deferred = excluded.filter((e) => e.reason === "overlap" || e.reason === "degraded-cap").length;

  return { selected, backlog, excluded, deferred, drain: selected.length === 0 && backlog.length === 0 && deferred === 0 };
}

// --- Renovate lane (--mode renovate) ---------------------------------------
//
// Selection for the stalled-Renovate-PR tending lane. Same pure-function
// discipline as selectIssues (run.mjs owns the gh fetches). Overlap/degraded
// analysis does not apply — each worker tends its own PR branch, so there is
// no shared-file collision to de-conflict; the safety here is escalation
// (R7) and the cap (R8).

const RENOVATE_LOGIN = "app/renovate";
// GitHub CheckRun conclusions that mean a check failed (R2a). PENDING /
// SUCCESS / SKIPPED / NEUTRAL are not stalling.
const STALLING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const STALLING_MERGE_STATES = new Set(["DIRTY", "BEHIND"]);

// A statusCheckRollup entry is either a CheckRun (name/status/conclusion) or a
// legacy StatusContext (context/state). Normalize both to {name, failing,
// pending}, or return null for an entry that carries no signal — a StatusContext
// with no state is a placeholder gh sometimes emits; counting it as pending
// would make an all-green PR permanently "undecided" and unreachable-green.
function normalizeCheck(c) {
  if (c.__typename === "StatusContext" || c.state !== undefined) {
    const state = String(c.state ?? "").toUpperCase();
    if (state === "") return null; // stateless placeholder — inert, not pending
    return { name: c.context ?? "", failing: state === "FAILURE" || state === "ERROR", pending: state === "PENDING" || state === "EXPECTED" };
  }
  const conclusion = c.conclusion ?? null;
  const status = String(c.status ?? "").toUpperCase();
  // Decided only when COMPLETED with a non-null conclusion; QUEUED/IN_PROGRESS
  // or a null conclusion is still pending.
  return { name: c.name ?? "", failing: STALLING_CONCLUSIONS.has(conclusion), pending: status !== "COMPLETED" || conclusion === null };
}

// R2a: stalled = a failing (required) check, OR merge state DIRTY/BEHIND.
// All-decided-green + not-dirty → not-stalled. Anything still pending, an
// empty relevant-check set, or an UNKNOWN merge state → undecided (never
// selected, never recorded green). Returns "failing-check" | "merge-state" |
// "not-stalled" | "undecided".
function stallState(pr, requiredContexts) {
  const all = (pr.statusCheckRollup ?? []).map(normalizeCheck).filter(Boolean);
  // Only required checks stall the PR when branch protection names a set;
  // without one (unreadable/unprotected), any failing check stalls.
  const evaluated = requiredContexts && requiredContexts.length ? all.filter((c) => requiredContexts.includes(c.name)) : all;
  if (evaluated.some((c) => c.failing)) return "failing-check";
  const ms = String(pr.mergeStateStatus ?? "").toUpperCase();
  if (STALLING_MERGE_STATES.has(ms)) return "merge-state";
  if (ms === "UNKNOWN" || ms === "") return "undecided";
  if (evaluated.length === 0 || evaluated.some((c) => c.pending)) return "undecided";
  return "not-stalled";
}

/**
 * @param {object} args
 * @param {Array} args.prs  [{number, title, headRefName, isDraft, author:{login}, statusCheckRollup, mergeStateStatus, labels}] (labels: string[] of label names)
 * @param {number[]} args.inFlight   PR numbers already being tended
 * @param {number[]} args.escalated  PR numbers durably excluded this run (R7)
 * @param {string[]|null} args.requiredContexts  required check names from branch protection; null = unavailable → any-failing fallback
 * @param {number} args.cap  max TOTAL workers; hard-capped at 3 (R8)
 * @param {string[]} [args.branchPrefixes]  config renovate.branchPrefixes: head-branch prefixes a tendable PR carries
 * @param {string[]} [args.securityPrefixes]  config renovate.securityPrefixes: prefixes that mark a security bump (sorted first)
 * @returns {{selected: Array, backlog: Array, excluded: Array, drain: boolean}}
 */
export function selectStalledRenovatePRs({ prs, inFlight = [], escalated = [], requiredContexts = null, cap = 3, branchPrefixes = ["renovate/"], securityPrefixes = [] }) {
  const hasPrefix = (ref, prefixes) => prefixes.some((p) => (ref ?? "").startsWith(p));
  const excluded = [];
  const candidates = [];
  const inFlightSet = new Set(inFlight);
  const escalatedSet = new Set(escalated);

  for (const pr of prs) {
    const n = pr.number;
    // Author AND branch prefix must both mark it a tendable Renovate PR.
    if (pr.author?.login !== RENOVATE_LOGIN || !hasPrefix(pr.headRefName, branchPrefixes)) {
      excluded.push({ number: n, reason: "not-renovate" });
      continue;
    }
    if (pr.isDraft) {
      excluded.push({ number: n, reason: "draft" });
      continue;
    }
    // Cross-run claim signal: the inFlight/escalated args are per-run,
    // but an agent-lifecycle label on the PR is visible to every concurrent run.
    if ((pr.labels ?? []).some((l) => IN_FLIGHT_AGENT_LABELS.has(l))) {
      excluded.push({ number: n, reason: "claimed-by-agent" });
      continue;
    }
    if (escalatedSet.has(n)) {
      excluded.push({ number: n, reason: "escalated" });
      continue;
    }
    if (inFlightSet.has(n)) {
      excluded.push({ number: n, reason: "claimed" });
      continue;
    }
    const state = stallState(pr, requiredContexts);
    if (state === "not-stalled" || state === "undecided") {
      excluded.push({ number: n, reason: state });
      continue;
    }
    candidates.push({
      number: n,
      title: pr.title,
      headRefName: pr.headRefName,
      security: hasPrefix(pr.headRefName, securityPrefixes),
      reason: state,
    });
  }

  // Security bumps (configured securityPrefixes) first, then PR number asc.
  candidates.sort((a, b) => Number(b.security) - Number(a.security) || a.number - b.number);

  // Cap bounds the total roster (R8); budget subtracts workers already tending.
  const budget = Math.max(0, safeCap(cap) - inFlight.length);
  const selected = candidates.slice(0, budget);
  const backlog = candidates.slice(budget);

  // `undecided` is transient — CI is still running, so those PRs may become
  // stalled on a later tick. They must NOT drain the run (mirrors the issue
  // lane's overlap/degraded `deferred`, select.mjs above). drain fires only
  // when nothing is stalled AND nothing is mid-CI.
  const deferred = excluded.filter((e) => e.reason === "undecided").length;

  return { selected, backlog, excluded, deferred, drain: selected.length === 0 && backlog.length === 0 && deferred === 0 };
}
