#!/usr/bin/env node
// acceptance-verdict/v1: hash the Gherkin artifact, stamp a judge fingerprint,
// validate a verdict, compose the top-level verdict fail-closed, and persist it
// keyed to SHA + artifact hash.
//
// ponytail: hand-written validator, swap for a JSON-schema lib if the schema grows past one page.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSIONS, lint, listScenarios } from "./gherkin.mjs";

export const SCHEMA = "acceptance-verdict/v1";
export const ACCEPTANCE_DIR = ".tmp/acceptance";

const STAGES = ["spec", "build"];
export const VERDICTS = ["PASS", "CONCERNS", "REJECT", "unevaluated"];
const DIMENSION_STATUS = ["PASS", "CONCERNS", "REJECT", "unevaluated", "not_applicable"];
const ROUTE_RESULTS = ["Pass", "Fail", "Skip"];
const SCENARIO_STATUS = ["held", "manifested", "unevaluated"];
const REQUIRED_DIMS = { build: DIMENSIONS, spec: ["workflow-fit", "intent-match"] };
// A reason on an unevaluated verdict that names one of these implies no artifact exists yet,
// so artifact_hash must be null.
const ARTIFACT_UNAVAILABLE_CODES = ["insufficient-intent", "missing-artifact", "no-artifact", "artifact-unavailable"];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** sha256 of the exact Gherkin bytes. */
export function hashArtifact(text) {
  return sha256(text ?? "");
}

/** Judge identity: model id folded with a hash of the judge file. */
export function judgeFingerprint(judgeText, modelId) {
  return `${modelId}@${sha256(judgeText ?? "")}`;
}

/** A target not on the loopback host is a deployed target, which can show real data. Absent = local. */
export function isRemoteTarget(url) {
  if (!url) return false;
  return !/^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

function reasonIsArtifactUnavailable(reason) {
  return typeof reason === "string" && ARTIFACT_UNAVAILABLE_CODES.some((c) => reason.includes(c));
}

/** Hand-written shape check against acceptance-verdict/v1. Returns {ok, errors[]}. */
export function validate(verdict) {
  const errors = [];
  if (!verdict || typeof verdict !== "object") return { ok: false, errors: ["verdict: not an object"] };

  if (!STAGES.includes(verdict.stage)) errors.push(`stage: missing or invalid (${verdict.stage})`);
  if (!VERDICTS.includes(verdict.verdict)) errors.push(`verdict: missing or invalid (${verdict.verdict})`);
  if (typeof verdict.sha !== "string" || verdict.sha.length === 0) errors.push("sha: missing");
  if (typeof verdict.judge_fingerprint !== "string" || verdict.judge_fingerprint.length === 0) errors.push("judge_fingerprint: missing");
  if (typeof verdict.generated_at !== "string" || verdict.generated_at.length === 0) errors.push("generated_at: missing");

  if (!("artifact_hash" in verdict) || !(verdict.artifact_hash === null || typeof verdict.artifact_hash === "string"))
    errors.push("artifact_hash: must be a string or null");

  if (!verdict.dimensions || typeof verdict.dimensions !== "object") {
    errors.push("dimensions: missing");
  } else {
    for (const [name, d] of Object.entries(verdict.dimensions)) {
      if (!d || !DIMENSION_STATUS.includes(d.status)) errors.push(`dimension ${name}: invalid status (${d && d.status})`);
    }
  }
  for (const r of verdict.routes ?? []) {
    if (!ROUTE_RESULTS.includes(r.result)) errors.push(`route ${r.route}: invalid result (${r.result})`);
  }
  for (const s of verdict.scenarios ?? []) {
    if (!SCENARIO_STATUS.includes(s.status)) errors.push(`scenario ${s.id ?? s.dimension}: invalid status (${s.status})`);
  }

  if (verdict.verdict === "unevaluated" && (typeof verdict.reason !== "string" || verdict.reason.length === 0))
    errors.push("reason: required when verdict is unevaluated");

  if (verdict.artifact_hash === null && verdict.verdict !== "unevaluated") errors.push("artifact_hash: null is only valid on an unevaluated verdict");

  if (verdict.verdict === "unevaluated" && reasonIsArtifactUnavailable(verdict.reason) && verdict.artifact_hash !== null)
    errors.push("artifact_hash: must be null on an artifact-unavailable unevaluated verdict");

  return { ok: errors.length === 0, errors };
}

/**
 * An execution manifest is honored only when it is verified AND bound to this exact run:
 * same commit sha, same composed artifact_hash, and its route table is a superset of routes[]
 * with matching results. A bare {verified:true}, or one from a different commit or route set,
 * can never earn a PASS.
 */
function manifestHonored(manifest, { sha, artifact_hash, routes }) {
  if (!manifest || manifest.verified !== true) return false;
  if (manifest.sha !== sha) return false;
  if (manifest.artifact_hash !== artifact_hash) return false;
  const byRoute = new Map((Array.isArray(manifest.routes) ? manifest.routes : []).map((r) => [r.route, r.result]));
  return routes.every((r) => byRoute.get(r.route) === r.result);
}

/**
 * Shared fail-closed derivation for fresh judgments and re-verification:
 *   any REJECT dimension → REJECT;
 *   else any reason in leadReasons, any REQUIRED dimension unevaluated or not_applicable, or, at
 *        build, a required dimension without a matching scenario on an exercised route plus
 *        non-empty evidence, any route row Skip/Fail/unevaluable, any declared route not
 *        exercised, any scenario on an unexercised route or not held/manifested, or an unhonored
 *        execution manifest → unevaluated, with every reason;
 *   else any CONCERNS → CONCERNS;
 *   else PASS.
 */
function deriveTopLevel({ stage, dimensions, routes, scenarios, artifact_hash, sha, manifest, declaredRoutes = [], leadReasons = [] }) {
  const isBuild = stage === "build";

  if (Object.values(dimensions).some((d) => d && d.status === "REJECT")) return { verdict: "REJECT", reasons: [] };

  const reasons = [...leadReasons];
  const exercised = new Set(routes.map((r) => r.route));

  for (const name of REQUIRED_DIMS[stage] ?? []) {
    const d = dimensions[name];
    if (!d || d.status === "unevaluated") {
      reasons.push(`dimension ${name} unevaluated`);
      continue;
    }
    // not_applicable is tolerated only on a dimension the stage does not require.
    if (d.status === "not_applicable") {
      reasons.push(`dimension ${name} not_applicable`);
      continue;
    }
    if (isBuild) {
      if (!scenarios.some((s) => s.dimension === name && exercised.has(s.route))) reasons.push(`dimension ${name} has no matching @dimension scenario`);
      const hasEvidence = Array.isArray(d.evidence) && d.evidence.length > 0 && d.evidence.every((e) => typeof e === "string" && e.trim().length > 0);
      if (!hasEvidence) reasons.push(`dimension ${name} has no evidence`);
    }
  }

  if (isBuild) {
    for (const dr of declaredRoutes) {
      if (!exercised.has(dr)) reasons.push(`declared route ${dr} not exercised`);
    }
    for (const r of routes) {
      if (r.result === "Skip") reasons.push(`route ${r.route} skipped: ${r.reason || "skip"}`);
      else if (r.result === "Fail") reasons.push(`route ${r.route} failed`);
      else if (r.result !== "Pass") reasons.push(`route ${r.route} unevaluable (${r.result})`);
    }
    for (const s of scenarios) {
      if (s.route !== undefined && !exercised.has(s.route)) reasons.push(`scenario ${s.id ?? s.dimension} on unexercised route ${s.route}`);
    }
    for (const s of scenarios) {
      if (!["held", "manifested"].includes(s.status)) reasons.push(`scenario ${s.id ?? s.dimension} unevaluated`);
    }
    if (!manifestHonored(manifest, { sha, artifact_hash, routes })) reasons.push("execution manifest missing or unverified");
  }

  if (reasons.length > 0) return { verdict: "unevaluated", reasons };
  if (Object.values(dimensions).some((d) => d && d.status === "CONCERNS")) return { verdict: "CONCERNS", reasons: [] };
  return { verdict: "PASS", reasons: [] };
}

/**
 * Re-derive the top-level verdict from a persisted verdict's OWN recorded components. A consumer
 * uses this to prove they earn the claimed verdict: a forged empty PASS re-derives to unevaluated,
 * and a recorded unevaluated never re-derives to PASS. Returns one of VERDICTS.
 */
export function topLevelFromRecorded(verdict) {
  const artifact_hash = verdict.artifact_hash ?? null;
  const leadReasons = [];
  if (artifact_hash === null) leadReasons.push(verdict.reason ?? "artifact-unavailable");
  else if (verdict.verdict === "unevaluated") leadReasons.push(verdict.reason ?? "unevaluated");
  return deriveTopLevel({
    stage: verdict.stage,
    dimensions: verdict.dimensions ?? {},
    routes: verdict.routes ?? [],
    scenarios: verdict.scenarios ?? [],
    artifact_hash,
    sha: verdict.sha,
    manifest: verdict.manifest,
    leadReasons,
  }).verdict;
}

// Every parsed scenario recorded once, each on a route it declares. A dropped scenario
// would otherwise pass silently.
function scenarioCoverageReasons(parsed, recorded) {
  const reasons = [];
  const byId = new Map(parsed.map((s) => [s.id, s]));
  const seen = new Set();
  for (const row of recorded) {
    const declared = byId.get(row.id);
    if (!declared) {
      reasons.push(`scenario ${row.id} is not in the artifact`);
      continue;
    }
    if (seen.has(row.id)) reasons.push(`scenario ${row.id} recorded more than once`);
    seen.add(row.id);
    if (!declared.routes.includes(row.route)) reasons.push(`scenario ${row.id} recorded on undeclared route ${row.route}`);
  }
  for (const s of parsed) {
    if (!seen.has(s.id)) reasons.push(`scenario ${s.id} missing from the verdict`);
  }
  return reasons;
}

/**
 * Compose the top-level verdict fail-closed (see deriveTopLevel). artifact_hash is null only when
 * no artifact exists. The build-stage execution manifest is recorded so a consumer can re-verify it.
 */
export function compose(draft, { artifactText, sha, fingerprint, manifest, reason } = {}) {
  const stage = draft.stage;
  const isBuild = stage === "build";
  const dimensions = draft.dimensions ?? {};
  const routes = draft.routes ?? [];
  const scenarios = draft.scenarios ?? [];

  const artifactAvailable = typeof artifactText === "string" && artifactText.length > 0;
  const artifact_hash = artifactAvailable ? hashArtifact(artifactText) : null;

  const base = {
    schema: SCHEMA,
    stage,
    sha,
    artifact_hash,
    artifact_path: draft.artifact_path ?? null,
    judge_fingerprint: fingerprint,
    dimensions,
    routes,
    scenarios,
    generated_at: new Date().toISOString(),
  };
  if (isBuild) {
    base.target_url = draft.target_url ?? null;
    base.manifest = manifest ?? null; // recorded so a gate can re-verify the run bound to this verdict
    if (draft.evidence_redacted === true) base.evidence_redacted = true;
  }

  const leadReasons = [];
  const stated = draft.reason ?? reason;
  if (stated) leadReasons.push(stated);
  if (!artifactAvailable && !stated) leadReasons.push("artifact-unavailable");

  let declaredRoutes = [];
  if (artifactAvailable) {
    const linted = lint(artifactText);
    if (!linted.ok) {
      leadReasons.push(...linted.errors.map((e) => `malformed-artifact: ${e.line}: ${e.message}`));
    } else {
      const parsed = listScenarios(artifactText);
      declaredRoutes = [...new Set(parsed.flatMap((s) => s.routes))];
      if (isBuild) leadReasons.push(...scenarioCoverageReasons(parsed, scenarios));
    }
  }

  const { verdict, reasons } = deriveTopLevel({ stage, dimensions, routes, scenarios, artifact_hash, sha, manifest, declaredRoutes, leadReasons });

  if (verdict === "unevaluated") return { ...base, verdict, reason: reasons.join("; ") };
  return { ...base, verdict };
}

/** Create the working directory with a self-ignoring .gitignore, so evidence never needs a repo edit to stay out of git. */
export function ensureAcceptanceDir(baseDir = resolve(process.cwd(), ACCEPTANCE_DIR)) {
  mkdirSync(baseDir, { recursive: true });
  const ignore = join(baseDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return baseDir;
}

/** 7-hex digest of the judge fingerprint. A model or judge change re-keys the file instead of overwriting a stale verdict. */
export function fingerprintKey(fingerprint) {
  return sha256(fingerprint ?? "").slice(0, 7);
}

/** Write the verdict to <baseDir>/<stage>-<sha7>-<hash7>-<fp7>.json. Returns the path. */
export function persist(verdict, { baseDir } = {}) {
  const dir = ensureAcceptanceDir(baseDir);
  const sha7 = (verdict.sha ?? "0000000").slice(0, 7);
  const hash7 = verdict.artifact_hash ? verdict.artifact_hash.slice(0, 7) : "noartf";
  const fp7 = fingerprintKey(verdict.judge_fingerprint);
  const file = join(dir, `${verdict.stage}-${sha7}-${hash7}-${fp7}.json`);
  writeFileSync(file, JSON.stringify(verdict, null, 2) + "\n");
  return file;
}

function main([cmd, ...rest]) {
  switch (cmd) {
    case "hash": {
      process.stdout.write(hashArtifact(readFileSync(rest[0], "utf8")) + "\n");
      return 0;
    }
    case "fingerprint": {
      const [judgeFile, modelId] = rest;
      const judgeText = existsSync(judgeFile) ? readFileSync(judgeFile, "utf8") : "";
      process.stdout.write(judgeFingerprint(judgeText, modelId) + "\n");
      return 0;
    }
    case "validate": {
      const res = validate(JSON.parse(readFileSync(rest[0], "utf8")));
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return res.ok ? 0 : 1;
    }
    case "compose": {
      // compose <draft.json> <artifact.feature|-> <sha> <fingerprint> [manifest.json]
      const [draftFile, artifactFile, sha, fingerprint, manifestFile] = rest;
      const draft = JSON.parse(readFileSync(draftFile, "utf8"));
      const artifactText = artifactFile && artifactFile !== "-" ? readFileSync(artifactFile, "utf8") : undefined;
      const manifest = manifestFile ? JSON.parse(readFileSync(manifestFile, "utf8")) : undefined;
      const v = compose(draft, { artifactText, sha, fingerprint, manifest });
      const file = persist(v);
      process.stdout.write(JSON.stringify(v, null, 2) + "\n");
      process.stderr.write(`persisted: ${file}\n`);
      return 0;
    }
    case "rederive": {
      // A consumer treats recorded !== derived as forged.
      const v = JSON.parse(readFileSync(rest[0], "utf8"));
      process.stdout.write(JSON.stringify({ recorded: v.verdict, derived: topLevelFromRecorded(v), sha: v.sha }) + "\n");
      return 0;
    }
    default:
      process.stderr.write("usage: verdict.mjs <hash|fingerprint|validate|compose|rederive> ...\n");
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
