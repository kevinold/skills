// Per-repo configuration for the multi-worker-pm spine.
//
// The PM becomes portable by CONFIGURATION, never by forking: every repo fact
// the scripts would otherwise hardcode — the base branch, commit-subject
// prefixes, what proves a lane green, the automation identity, the post-merge
// bar, the primary-only files a worker needs — lives in one
// `.multi-worker-pm.json` at the repo root, with neutral built-in DEFAULTS
// underneath. Facts that cannot be guessed safely (the authors whose `state:`
// comments are trusted) have no default: the mode that needs them refuses.
//
// Trust model (KTD3): the config file is a control that constrains the lanes, so
// it is read from the PRIMARY checkout only — `--primary` / `$SPINE_PRIMARY`,
// else the git common-dir of the current checkout, NEVER `process.cwd()`. A
// SUPPLIED root must itself be a git checkout outside `.claude/worktrees/`, and
// the file loaded — default or explicit `--config` — must lie inside that root
// and outside `.claude/worktrees/`, so no flag can point the loader at a
// lane-authored file. Every value is a literal token, file name or path; this module
// anchors tokens and builds any regex itself, so no config key ever carries a
// raw regex, a shell fragment or prompt text.
//
// Validation collects EVERY problem and fails closed (R3) — a malformed,
// unknown-key or invalid-value file stops the entrypoint, it never silently
// falls back to defaults.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_FILENAME = ".multi-worker-pm.json";

// Neutral defaults: a repo with no config file gets exactly this. There is
// deliberately no `identity` — spine mode refuses without identity.expectedAuthors
// rather than trusting a guessed login. `protectedBranches` defaults to
// [baseBranch] where it is read, so a repo that only moves its base stays right.
export const DEFAULTS = {
  version: 1,
  baseBranch: "main",
  subjects: {
    preview: { prefixes: ["feat", "fix", "refactor", "chore", "docs", "test"], skipCd: "ignored" },
    chore: { prefixes: ["chore", "docs", "test"], skipCd: "ignored" },
  },
  checks: { required: [], previewContext: null },
  postMergeBar: {
    preview: { mode: "push", workflow: "ci.yml", runs: 1 },
    chore: { mode: "push", workflow: "ci.yml", runs: 1 },
    maxRuns: 3,
    timeoutMinutes: 60,
  },
  workerEnvFiles: [],
  dangerPaths: [],
  protectedPaths: [],
  workerKind: "claude",
  // Renovate lane: which Renovate branches are tended, and which of those are
  // security bumps (sorted first). Renovate's own default prefix is `renovate/`.
  renovate: { branchPrefixes: ["renovate/"], securityPrefixes: [] },
};

// Top-level keys the file may supply. `_meta` (a free-form provenance note) is
// ignored rather than rejected; `version` is reserved for the schema version.
const TOP_LEVEL_KEYS = [
  "version", "baseBranch", "protectedBranches", "subjects", "checks", "identity", "postMergeBar",
  "workerEnvFiles", "dangerPaths", "protectedPaths", "workerKind", "denyHook", "renovate",
];
const SUBJECT_KINDS = ["preview", "chore"];
const SKIP_CD_POLICIES = ["forbidden", "required", "ignored"];
const BAR_MODES = ["dispatch", "push"];
const BAR_KEYS = ["mode", "workflow", "runs", "inputs", "retryMarker"];
// A merge that walked into one of these could poison Object.prototype.
const PROTO_SLOTS = new Set(["__proto__", "constructor", "prototype"]);
// The marker is matched as a FIXED STRING, so literal parens are fine (e.g.
// "(Attempt 2 of"); character classes and quantifiers are not, because
// a reader would reasonably expect them to mean what they do in a regex.
const REGEX_META = /[[\]*+?{}|\\^$]/;

export class PmConfigError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "PmConfigError";
    this.problems = problems;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the start-anchored commit-subject matcher for one lane kind (R10). A
 * prefix that already carries its own literal scope (`fix(deps)`) matches
 * literally; a bare prefix additionally admits an optional conventional scope
 * (`chore(deps):`, `test(spine):`). The config supplies tokens only — the regex
 * is built here so a repo can never inject one.
 * @param {string[]} prefixes
 * @returns {RegExp}
 */
export function subjectPrefixRegex(prefixes) {
  const token = (p) => (/\)$/.test(p) ? escapeRe(p) : `${escapeRe(p)}(\\([\\w.-]+\\))?`);
  return new RegExp(`^(${prefixes.map(token).join("|")}):`);
}

// --- validation (collect every problem, KTD1) --------------------------------

/**
 * Validate a defaults-applied config against the KTD2 schema table.
 * @param {object} config
 * @returns {string[]} every problem found, empty when the config is valid
 */
export function validatePmConfig(config) {
  const problems = [];
  const add = (m) => problems.push(m);
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["config must be a JSON object"];

  const unknown = (obj, known, path) => {
    for (const k of Object.keys(obj)) if (!known.includes(k)) add(`unknown config key: ${path ? `${path}.` : ""}${k}`);
  };
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const obj = (v, path) => {
    if (isObj(v)) return true;
    add(`${path} must be an object`);
    return false;
  };
  const str = (v, path) => {
    if (typeof v === "string" && v.length > 0) return true;
    add(`${path} must be a non-empty string`);
    return false;
  };
  const strArray = (v, path, { allowEmpty = false } = {}) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) {
      add(`${path} must be an array of non-empty strings`);
      return false;
    }
    if (!allowEmpty && v.length === 0) {
      add(`${path} must not be empty`);
      return false;
    }
    return true;
  };
  const posInt = (v, path) => {
    if (!Number.isInteger(v) || v < 1) add(`${path} must be an integer >= 1`);
  };
  const oneOf = (v, allowed, path) => {
    if (!allowed.includes(v)) add(`${path} must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`);
  };

  unknown(config, TOP_LEVEL_KEYS, "");

  if (config.version !== 1) add(`version must be 1 (got ${JSON.stringify(config.version)})`);

  if (obj(config.subjects, "subjects")) {
    unknown(config.subjects, SUBJECT_KINDS, "subjects");
    for (const kind of SUBJECT_KINDS) {
      const s = config.subjects[kind];
      if (!obj(s, `subjects.${kind}`)) continue;
      unknown(s, ["prefixes", "skipCd"], `subjects.${kind}`);
      strArray(s.prefixes, `subjects.${kind}.prefixes`);
      if (!("skipCd" in s)) add(`subjects.${kind}.skipCd is required (a supplied key replaces the default whole and must be complete)`);
      else oneOf(s.skipCd, SKIP_CD_POLICIES, `subjects.${kind}.skipCd`);
    }
  }

  if (obj(config.checks, "checks")) {
    unknown(config.checks, ["required", "previewContext"], "checks");
    // Empty is allowed: it means "at least one check reported and every one
    // succeeded" (deriveChecksFromRollup) — never "no checks, so green".
    strArray(config.checks.required, "checks.required", { allowEmpty: true });
    if (!("previewContext" in config.checks)) add("checks.previewContext is required (use null to drop the requirement)");
    else if (config.checks.previewContext !== null) str(config.checks.previewContext, "checks.previewContext");
  }

  // Optional: absent means spine mode refuses (config-missing), issues mode runs.
  if ("identity" in config && obj(config.identity, "identity")) {
    unknown(config.identity, ["expectedAuthors"], "identity");
    strArray(config.identity.expectedAuthors, "identity.expectedAuthors");
  }

  if (obj(config.postMergeBar, "postMergeBar")) {
    unknown(config.postMergeBar, [...SUBJECT_KINDS, "maxRuns", "timeoutMinutes"], "postMergeBar");
    posInt(config.postMergeBar.maxRuns, "postMergeBar.maxRuns");
    posInt(config.postMergeBar.timeoutMinutes, "postMergeBar.timeoutMinutes");
    for (const kind of SUBJECT_KINDS) {
      const bar = config.postMergeBar[kind];
      const path = `postMergeBar.${kind}`;
      if (!obj(bar, path)) continue;
      unknown(bar, BAR_KEYS, path);
      oneOf(bar.mode, BAR_MODES, `${path}.mode`);
      str(bar.workflow, `${path}.workflow`);
      posInt(bar.runs, `${path}.runs`);
      // push mode is the run the base-branch push itself triggered: exactly one,
      // and no dispatch inputs to give it (KTD4). Its flow is select-push-run.sh
      // + watch-run.sh, which scan no log — only dispatch-preview-bar.sh does —
      // so a retryMarker here would silently never fire and certify a run that
      // retried into green.
      if (bar.mode === "push") {
        if (bar.runs !== 1) add(`${path}.runs must be 1 in push mode`);
        if ("inputs" in bar) add(`${path}.inputs is not allowed in push mode`);
        if ("retryMarker" in bar) add(`${path}.retryMarker is not allowed in push mode`);
      }
      if ("inputs" in bar && obj(bar.inputs, `${path}.inputs`)) {
        for (const [k, v] of Object.entries(bar.inputs)) {
          if (!str(v, `${path}.inputs.${k}`)) continue;
          // ${sha} is the ONLY placeholder the bar step substitutes.
          for (const ph of v.match(/\$\{[^}]*\}/g) ?? []) {
            if (ph !== "${sha}") add(`${path}.inputs.${k} carries ${ph}; \${sha} is the only placeholder allowed`);
          }
        }
      }
      if ("retryMarker" in bar && str(bar.retryMarker, `${path}.retryMarker`) && REGEX_META.test(bar.retryMarker)) {
        add(`${path}.retryMarker must be a literal substring — regex metacharacters are rejected`);
      }
    }
  }

  strArray(config.workerEnvFiles, "workerEnvFiles", { allowEmpty: true });
  str(config.baseBranch, "baseBranch");
  if ("protectedBranches" in config) strArray(config.protectedBranches, "protectedBranches");
  strArray(config.dangerPaths, "dangerPaths", { allowEmpty: true });
  strArray(config.protectedPaths, "protectedPaths", { allowEmpty: true });
  str(config.workerKind, "workerKind");
  if ("denyHook" in config) str(config.denyHook, "denyHook");
  if (obj(config.renovate, "renovate")) {
    unknown(config.renovate, ["branchPrefixes", "securityPrefixes"], "renovate");
    strArray(config.renovate.branchPrefixes, "renovate.branchPrefixes");
    if ("securityPrefixes" in config.renovate) strArray(config.renovate.securityPrefixes, "renovate.securityPrefixes", { allowEmpty: true });
  }

  return problems;
}

// --- path resolution (KTD3) ---------------------------------------------------

export const argAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// The primary checkout of a linked worktree, via its git common dir. `cwd` is
// only the directory git is asked FROM — it is never itself taken as the root,
// so a PM running inside a worktree still resolves the primary's file.
// git resolves a repo from GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the
// ENVIRONMENT ahead of `cwd`, and a git hook (pre-push, post-checkout) exports
// them. Left ambient, `--primary`/cwd discovery would silently resolve whatever
// repo invoked the hook instead of the one this run was pointed at — the same
// substitution the supplied-root validation above refuses. Strip them so the
// primary comes only from the flag, the env var, or `cwd`.
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
];

export function gitFreeEnv(env = process.env) {
  const out = { ...env };
  for (const k of GIT_LOCATION_VARS) delete out[k];
  return out;
}

function gitCommonRoot(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitFreeEnv() }).trim();
    if (!out) return null;
    const gitDir = resolve(cwd, out);
    return gitDir.endsWith(`${sep}.git`) ? dirname(gitDir) : null;
  } catch {
    // No git on PATH, or not a checkout: there is no primary to read a file
    // from, so the caller falls back to DEFAULTS and says so in the digest line.
    return null;
  }
}

const realOrResolved = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));

/**
 * Resolve the primary checkout root: `--primary`, else `$SPINE_PRIMARY`, else
 * the git common-dir of `cwd`. Never `process.cwd()` itself.
 *
 * A SUPPLIED root is itself a control and is validated (KTD3): `insidePrimary`
 * below measures containment RELATIVE to this root, so an unvalidated one would
 * let `--primary <lane worktree>` make the lane's own config authoritative — the
 * very thing the `--config` rule refuses. A root DISCOVERED from git needs no
 * such check and an ABSENT one is not an error: null means "no primary, use
 * DEFAULTS", which is the documented no-git fallback.
 * @returns {string|null}
 * @throws {PmConfigError} when an explicitly supplied root is not a usable primary
 */
export function resolvePrimaryRoot({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const supplied = argAfter(argv, "--primary") || env.SPINE_PRIMARY;
  if (!supplied) return gitCommonRoot(cwd);
  const root = realOrResolved(resolve(supplied));
  const problems = [];
  if (`${root}${sep}`.includes(`${sep}.claude${sep}worktrees${sep}`)) {
    problems.push(`primary-inside-worktree: ${root} is a lane worktree, not the primary checkout`);
  }
  // The same probe lib.sh's `primary_path` uses: a linked worktree's .git is a
  // file, the primary's a directory, and anything else is not a checkout at all.
  if (!existsSync(join(root, ".git"))) problems.push(`primary-not-a-checkout: ${root} has no .git`);
  if (problems.length) throw new PmConfigError(problems);
  return root;
}

// Inside the primary AND outside its worktrees: a lane's own checkout lives
// under .claude/worktrees/, which is *inside* the root by path but is exactly
// the copy a lane could author.
function insidePrimary(root, path) {
  const rel = relative(realOrResolved(root), realOrResolved(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !`${sep}${rel}${sep}`.includes(`${sep}.claude${sep}worktrees${sep}`);
}

// --- loading ------------------------------------------------------------------

const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// `root` rides along so callers that already loaded the config never re-run
// `git rev-parse --git-common-dir` for a value this load just computed.
function result(config, path, digest, root) {
  return { config, path, digest, root, source: path ? "file" : "defaults", line: `config: ${path ?? "defaults"} sha256:${digest}` };
}

/**
 * Load and validate the per-repo config, applying the neutral DEFAULTS underneath.
 * A supplied top-level key REPLACES its default whole and must be complete — the
 * loader never merges inside a key, so a half-written block is a named error
 * rather than a silent blend of two repos' rules.
 * @param {object} [opts]
 * @param {string[]} [opts.argv]  reads --primary and --config
 * @param {object} [opts.env]     reads SPINE_PRIMARY
 * @param {string} [opts.cwd]     directory git is asked from (never used as the root)
 * @returns {{config:object, path:string|null, digest:string, root:string|null, source:"file"|"defaults", line:string}}
 * @throws {PmConfigError} with every problem collected
 */
export function loadPmConfig({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const root = resolvePrimaryRoot({ argv, env, cwd });
  const explicit = argAfter(argv, "--config");

  let path = null;
  if (explicit) {
    const candidate = resolve(explicit);
    if (!root || !insidePrimary(root, candidate)) {
      throw new PmConfigError([`config-outside-primary: ${candidate} is not inside the primary checkout ${root ?? "(unresolved)"}`]);
    }
    if (!existsSync(candidate)) throw new PmConfigError([`config file not found: ${candidate}`]);
    path = candidate;
  } else if (root && existsSync(join(root, CONFIG_FILENAME))) {
    // Both load paths share ONE containment rule: the default file is normally
    // trivially inside the root, but a symlink from there into a lane worktree is
    // not, and realpath is what sees the difference.
    const candidate = join(root, CONFIG_FILENAME);
    if (!insidePrimary(root, candidate)) {
      throw new PmConfigError([`config-outside-primary: ${candidate} is not inside the primary checkout ${root}`]);
    }
    path = candidate;
  }

  if (!path) return result(structuredClone(DEFAULTS), null, sha12(JSON.stringify(DEFAULTS)), root);

  const text = readFileSync(path, "utf8");
  const problems = [];
  const hostile = new Set();
  let parsed;
  try {
    // The reviver drops a prototype slot before it can reach the merge below;
    // JSON.parse itself never invokes the __proto__ setter, so Object.prototype
    // is untouched either way — the report is what stops the run.
    parsed = JSON.parse(text, function reviver(key, value) {
      if (PROTO_SLOTS.has(key)) {
        hostile.add(key);
        return undefined;
      }
      return value;
    });
  } catch (e) {
    throw new PmConfigError([`${path}: ${e.message}`]);
  }
  for (const k of hostile) problems.push(`config key "${k}" is a prototype slot and is not allowed`);

  const config = structuredClone(DEFAULTS);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("config must be a JSON object");
  } else {
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "_meta") continue; // provenance note — ignored, never an error
      config[k] = v;
    }
  }

  problems.push(...validatePmConfig(config));
  if (problems.length) throw new PmConfigError(problems.map((p) => `${path}: ${p}`));
  return result(config, path, sha12(text), root);
}
