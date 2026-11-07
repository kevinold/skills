#!/usr/bin/env node
// usage: attach-evidence.mjs [--dry-run] [--trailer <line>] [--pr <n>] [--notes-file <md>]
//   Turn the newest build verdict for HEAD into one PR or issue comment. Images are embedded
//   through `gh ... comment --attach`; text captures render as fenced excerpts.
//   Advisory: every failure path is one stderr line and exit 0, so nothing here ever blocks.
//
//   gh only rewrites a body `![alt](path)` that has a matching --attach, so the body's image
//   references must equal the attach set. composeComment renders an image only for a path in
//   `selection.files`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSIONS } from "./gherkin.mjs";
import { ACCEPTANCE_DIR, ensureAcceptanceDir, isRemoteTarget, validate } from "./verdict.mjs";

const GH_ATTACH_CAP = 50;
const EXCERPT_LINES = 40;
const ATTACHABLE = /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i;
const DIM_LABEL = {
  "workflow-fit": "Workflow-fit",
  legibility: "Legibility",
  "intent-match": "Intent-match",
  "convention-fit": "Convention-fit",
};
const STATUS_EMOJI = { PASS: "✅", CONCERNS: "🟡", REJECT: "❌", unevaluated: "⚪", not_applicable: "⚪" };

const stem = (p) => basename(p).replace(/\.[^.]+$/, "");

export function postedMarkerPath(sha7) {
  return `${ACCEPTANCE_DIR}/posted-${sha7}.json`;
}

/**
 * Union the dimensions' evidence: dedup in first-seen order, existence-check, then split into
 * images to attach (capped at 50) and text to excerpt. `missing` = recorded but absent;
 * `omitted` = dropped by the cap.
 */
export function selectEvidence(verdict, exists) {
  const seen = new Set();
  for (const name of DIMENSIONS) {
    for (const p of verdict.dimensions?.[name]?.evidence ?? []) {
      if (typeof p === "string" && p.length) seen.add(p);
    }
  }
  const unique = [...seen];
  const existing = unique.filter((p) => exists(p));
  const images = existing.filter((p) => ATTACHABLE.test(p));
  return {
    files: images.slice(0, GH_ATTACH_CAP),
    text: existing.filter((p) => !ATTACHABLE.test(p)),
    omitted: Math.max(0, images.length - GH_ATTACH_CAP),
    missing: unique.length - existing.length,
  };
}

// A fence longer than any backtick run in the content, so a capture cannot close its own excerpt.
function excerpt(content) {
  const lines = content.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, EXCERPT_LINES).join("\n");
  const longestRun = Math.max(2, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  const tail = lines.length > EXCERPT_LINES ? `\n… (${lines.length - EXCERPT_LINES} more lines)` : "";
  return `${fence}text\n${shown}\n${fence}${tail}`;
}

function firstLine(target) {
  if (!target) return "No app was driven for this verdict.";
  const stage = "the project's judge (`ko-acceptance-validator` build stage: four dimensions over the shared `.feature` scenarios).";
  return isRemoteTarget(target) ? `Drove the deployed preview (\`${target}\`), then judged the running app as ${stage}` : `Drove the local app (\`${target}\`), then judged the running app as ${stage}`;
}

/** Comment body. Renders the verdict's own generated_at and never reads the wall clock. */
export function composeComment(verdict, selection, { trailer, notes, readText } = {}) {
  const lines = [firstLine(verdict.target_url)];
  if (isRemoteTarget(verdict.target_url)) lines.push("", "_Evidence is redacted because a deployed target can show real data._");
  lines.push("");

  const routes = verdict.routes ?? [];
  if (routes.length) {
    lines.push("| Route | Result | Notes |", "| --- | --- | --- |");
    for (const r of routes) lines.push(`| ${r.route} | ${r.result} | ${r.reason ?? ""} |`);
    lines.push("");
  }

  lines.push(`### Acceptance verdict: **${verdict.verdict}** (advisory)`);
  if (verdict.verdict === "unevaluated" && verdict.reason) lines.push("", `> _Unevaluated:_ ${verdict.reason}`);
  lines.push("");

  const attached = new Set(selection.files);
  const excerpted = new Set(selection.text ?? []);
  const emitted = new Set(); // each file renders once, so an image maps 1:1 to its --attach
  for (const name of DIMENSIONS) {
    const d = verdict.dimensions?.[name];
    if (!d) continue;
    lines.push(`#### ${STATUS_EMOJI[d.status] ?? "⚪"} ${DIM_LABEL[name]} — ${d.status}`);
    for (const f of d.findings ?? []) lines.push(`> ${f}`);
    for (const p of d.evidence ?? []) {
      if (emitted.has(p)) continue;
      if (attached.has(p)) lines.push("", `![${stem(p)}](${p})`);
      else if (excerpted.has(p) && readText) lines.push("", excerpt(readText(p)));
      else continue;
      emitted.add(p);
    }
    lines.push("");
  }

  if (selection.omitted > 0) lines.push(`_${selection.omitted} screenshot${selection.omitted === 1 ? "" : "s"} omitted (50-file cap)._`);
  if (selection.missing > 0) lines.push(`_${selection.missing} evidence file${selection.missing === 1 ? "" : "s"} missing or outside the evidence directory, so not shown._`);

  if (notes && notes.trim()) lines.push("", "#### Reviewer notes", "", notes.trim());

  lines.push("", `_Judged ${verdict.generated_at} · advisory, never blocks merge._`);
  if (trailer) lines.push("", trailer);
  return lines.join("\n") + "\n";
}

/** PR wins; else the issue number in a `{type}-{N}-...` branch; else null. */
export function resolveTarget({ prNumber, branch }) {
  if (prNumber) return { kind: "pr", number: prNumber };
  const m = typeof branch === "string" ? branch.match(/^[a-z]+-(\d+)-/) : null;
  if (m) return { kind: "issue", number: Number(m[1]) };
  return null;
}

export function ghArgs(target, bodyPath, files) {
  const args = [target.kind, "comment", String(target.number), "--body-file", bodyPath];
  for (const f of files) args.push("--attach", `${f}#${stem(f)}`);
  return args;
}

/**
 * Find the HEAD build verdict, validate it, select evidence, resolve the target and post,
 * idempotently. All edges are injected.
 * @returns {{posted: boolean, note: string, body?: string}}
 */
export function run(deps, { dryRun = false, trailer, pr, notes } = {}) {
  const sha7 = deps.headSha7();
  if (!sha7) return { posted: false, note: "no HEAD sha" };

  const found = deps.findVerdict(sha7);
  if (!found) return { posted: false, note: `no build verdict for HEAD ${sha7}` };

  const { ok, errors } = validate(found.verdict);
  if (!ok) return { posted: false, note: `invalid verdict: ${errors.join("; ")}` };

  const verdict = found.verdict;
  const selection = selectEvidence(verdict, deps.exists);
  const evidence = [...selection.files, ...selection.text];
  // A deployed target can show real data, so its evidence never posts unmarked. A verdict that
  // names no target could be from one, so it is held to the same rule.
  if ((!verdict.target_url || isRemoteTarget(verdict.target_url)) && evidence.length > 0 && verdict.evidence_redacted !== true) {
    return { posted: false, note: `refused: remote target ${verdict.target_url ?? "(unnamed)"} evidence not marked redacted (evidence_redacted !== true)` };
  }

  const target = resolveTarget({ prNumber: pr ?? deps.prNumber(), branch: deps.branch() });
  if (!target) return { posted: false, note: "no PR or issue target" };

  const body = composeComment(verdict, selection, { trailer, notes, readText: deps.readText });

  if (dryRun) return { posted: false, note: `dry-run: composed body for ${target.kind} ${target.number}`, body };

  // Idempotent on the exact body, target and evidence set, so a corrected verdict still posts.
  const digest = createHash("sha256").update(body).digest("hex");
  if (deps.alreadyPosted(found.path, target, evidence, digest)) {
    return { posted: false, note: `already posted verdict ${basename(found.path)} to ${target.kind} ${target.number} for HEAD ${sha7}` };
  }

  const bodyPath = deps.writeBody(body);
  try {
    deps.gh(ghArgs(target, bodyPath, selection.files));
  } catch (e) {
    return { posted: false, note: `gh failed: ${e.message}` };
  }
  deps.writeMarker(sha7, target, found.path, evidence, digest);
  return { posted: true, note: `posted verdict to ${target.kind} ${target.number}`, body };
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : (argv[i + 1] ?? "");
  };
  const say = (msg) => process.stderr.write(`attach-evidence: ${msg}\n`);
  const prArg = flag("--pr");
  const notesFile = flag("--notes-file");
  const pr = prArg === undefined ? undefined : Number(prArg);
  if (prArg !== undefined && !(Number.isInteger(pr) && pr > 0)) return say(`--pr must be a positive integer (got "${prArg}")`);
  let notes;
  if (notesFile !== undefined) {
    try {
      notes = readFileSync(notesFile, "utf8");
    } catch (e) {
      return say(`--notes-file unreadable: ${e.message}`);
    }
  }

  const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const gh = (a) => execFileSync("gh", a, { encoding: "utf8" });
  const deps = {
    headSha7: () => {
      try {
        return git(["rev-parse", "HEAD"]).slice(0, 7);
      } catch {
        return null;
      }
    },
    findVerdict: (sha7) => {
      try {
        const newest = readdirSync(ACCEPTANCE_DIR)
          .filter((f) => f.startsWith(`build-${sha7}-`) && f.endsWith(".json"))
          .map((f) => ({ f, m: statSync(join(ACCEPTANCE_DIR, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        if (!newest) return null;
        const path = join(ACCEPTANCE_DIR, newest.f);
        return { path, verdict: JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        return null;
      }
    },
    // Only files under the evidence directory ever post, so a verdict naming .env or a symlink out cannot publish it.
    exists: (p) => {
      try {
        return realpathSync(p).startsWith(realpathSync(join(ACCEPTANCE_DIR, "evidence")) + sep);
      } catch {
        return false;
      }
    },
    readText: (p) => readFileSync(p, "utf8"),
    alreadyPosted: (verdictPath, target, files, digest) => {
      try {
        const sha7 = basename(verdictPath).split("-")[1];
        const marker = JSON.parse(readFileSync(postedMarkerPath(sha7), "utf8"));
        return (
          marker.digest === digest &&
          marker.verdict === basename(verdictPath) &&
          marker.target?.kind === target.kind &&
          marker.target?.number === target.number &&
          JSON.stringify(marker.evidence) === JSON.stringify(files)
        );
      } catch {
        return false;
      }
    },
    writeBody: (text) => {
      ensureAcceptanceDir();
      const p = join(ACCEPTANCE_DIR, "comment-build.md");
      writeFileSync(p, text);
      return p;
    },
    writeMarker: (sha7, target, verdictPath, files, digest) => {
      ensureAcceptanceDir();
      writeFileSync(postedMarkerPath(sha7), JSON.stringify({ target, verdict: basename(verdictPath), evidence: files, digest }, null, 2) + "\n");
    },
    gh,
    prNumber: () => {
      try {
        const n = Number(gh(["pr", "view", "--json", "number", "-q", ".number"]).trim());
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    branch: () => {
      try {
        return git(["rev-parse", "--abbrev-ref", "HEAD"]);
      } catch {
        return "";
      }
    },
  };

  try {
    const r = run(deps, { dryRun, trailer: flag("--trailer"), pr, notes });
    if (dryRun && r.body) process.stdout.write(r.body);
    say(r.note);
  } catch (e) {
    say(e.message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
