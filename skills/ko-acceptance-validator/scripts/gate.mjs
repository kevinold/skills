#!/usr/bin/env node
// Advisory gate consumer. Ingests a schema-valid build-stage verdict or nothing; never
// merges; always exits 0.
//
// ponytail: advisory only. It prints a decision line; wiring a merge to it is a separate step.

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashArtifact, topLevelFromRecorded, validate } from "./verdict.mjs";

/**
 * Decide whether a persisted verdict would let a gate proceed.
 * @param {string} verdictText raw verdict.json bytes
 * @param {string} featureText raw .feature bytes, for the hash recompute
 * @param {string} sha the commit SHA to check the verdict against
 * @param {string} [expectedFingerprint] when given, the verdict's judge_fingerprint must match it,
 *   since a judge or model change invalidates an older verdict
 * @returns {string} "would-pass" | "would-block: <reason>"
 */
export function gate(verdictText, featureText, sha, expectedFingerprint) {
  let verdict;
  try {
    verdict = JSON.parse(verdictText);
  } catch {
    return "would-block: unparseable"; // free-form prose is never ingested
  }

  const { ok, errors } = validate(verdict);
  if (!ok) return `would-block: invalid: ${errors.join("; ")}`;

  // A spec verdict never gates a merge, regardless of PASS, SHA or hash.
  if (verdict.stage !== "build") return "would-block: wrong-stage";

  if (verdict.verdict === "unevaluated") return `would-block: unevaluated: ${verdict.reason}`;
  if (verdict.verdict !== "PASS") return `would-block: ${verdict.verdict.toLowerCase()}`;
  if (!verdict.target_url) return "would-block: missing-target-url";

  if (hashArtifact(featureText ?? "") !== verdict.artifact_hash) return "would-block: artifact-drift";
  if (verdict.sha !== sha) return "would-block: sha-mismatch";
  if (expectedFingerprint !== undefined && verdict.judge_fingerprint !== expectedFingerprint) return "would-block: stale-fingerprint";

  // validate() checks shape only, so a forged PASS with empty components and a matching public
  // sha and hash passes it. Require the recorded components to earn the claimed PASS against the
  // file itself, so a dropped scenario or an unwalked route cannot slip through.
  if (topLevelFromRecorded(verdict, featureText ?? "") !== "PASS") return "would-block: not-earned";

  return "would-pass";
}

function main([verdictPath, featurePath, sha, expectedFingerprint]) {
  let verdictText;
  try {
    verdictText = readFileSync(verdictPath, "utf8");
  } catch {
    process.stdout.write("would-block: no-verdict\n");
    return;
  }
  let featureText;
  try {
    featureText = readFileSync(featurePath, "utf8");
  } catch {
    featureText = ""; // a missing artifact drifts the hash: would-block, never a throw
  }
  process.stdout.write(gate(verdictText, featureText, sha, expectedFingerprint) + "\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
