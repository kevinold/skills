import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// The published set: an installer copies the skill folder and nothing around
// it. The guards below read the published set off disk rather than a hand-kept
// list, so a new script is covered the moment it lands.
const published = (pred) => readdirSync(HERE).filter(pred);
const MJS = published((f) => f.endsWith(".mjs"));
const SH = published((f) => f.endsWith(".sh"));
const read = (f) => readFileSync(join(HERE, f), "utf8");

describe("published scripts import nothing outside the directory (R15)", () => {
  // A `../` import makes the whole module throw on load in a consumer, before
  // any command starts — `spine status` dies at import time with ERR_MODULE_NOT_FOUND.
  const RELATIVE = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g;

  it.each(MJS)("%s imports only siblings and bare specifiers", (file) => {
    const offenders = [...read(file).matchAll(RELATIVE)].map((m) => m[1]).filter((spec) => !spec.startsWith("./"));
    expect(offenders, `${file} imports outside the skill's scripts/`).toEqual([]);
  });
});

// --- The R5 literal guard ----------------------------------------------------
//
// One list, one sweep, no exemptions: no org, login, branch, cloud or tool fact
// from the repo this skill was extracted from may appear in the scripts
// (DEFAULTS included), the fixtures, the config example, the test files or the
// skill prose. The words are stored base64-encoded so neither this file nor a
// repo-wide grep for the same words ever matches the guard itself.
const R5_LITERALS = [
  "c3RhZ2luZw==", "YW1wbGlmeQ==", "aHVic3BvdA==", "Y2xhdWRlLWhvb2tz", "ZG9ydmll", "a2V2aW5vbGQ=", "ZGFuY2o=", "Y29nbml0bw==", "c3Rld2FyZA==", "Y3lwcmVzcy1lMmU=",
].map((w) => Buffer.from(w, "base64").toString());
// `vitest` is only a leaked fact as a check or workflow NAME (a quoted token),
// never as the test runner the suite imports — so test files skip this rule.
const VITEST_CHECK = /["'`]vitest(\.yml)?["'`]/;

export function sweepLiterals(name, src, { checkNames = true } = {}) {
  const hits = [];
  src.split("\n").forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const lit of R5_LITERALS) if (lower.includes(lit)) hits.push(`${name}:${i + 1}: ${lit}`);
    if (checkNames && VITEST_CHECK.test(line)) hits.push(`${name}:${i + 1}: vitest`);
  });
  return hits;
}

const FIXTURES = join(HERE, "__fixtures__");
const SKILL_DIR = join(HERE, "..");

describe("no R5 literal anywhere in the skill (R5)", () => {
  const code = [...MJS.filter((f) => !f.endsWith(".test.mjs")), ...SH];
  it.each(code)("%s carries no R5 literal (DEFAULTS included)", (file) => {
    expect(sweepLiterals(file, read(file))).toEqual([]);
  });

  it.each(readdirSync(FIXTURES))("__fixtures__/%s carries no R5 literal", (file) => {
    expect(sweepLiterals(file, readFileSync(join(FIXTURES, file), "utf8"))).toEqual([]);
  });

  it("config.example.json carries no R5 literal", () => {
    expect(sweepLiterals("config.example.json", readFileSync(join(SKILL_DIR, "config.example.json"), "utf8"))).toEqual([]);
  });

  // Identity literals (and every other R5 word) in test inputs: tests use neutral
  // placeholders (acme/app, acme-bot, alice). `vitest` is the runner here, not a check.
  it.each(MJS.filter((f) => f.endsWith(".test.mjs")))("%s carries no R5 literal in its test inputs", (file) => {
    expect(sweepLiterals(file, read(file), { checkNames: false })).toEqual([]);
  });

  it("SKILL.md carries no R5 literal", () => {
    expect(sweepLiterals("SKILL.md", readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"))).toEqual([]);
  });

  it("references/*.md carry no R5 literal", () => {
    const dir = join(SKILL_DIR, "references");
    for (const f of readdirSync(dir)) expect(sweepLiterals(`references/${f}`, readFileSync(join(dir, f), "utf8"))).toEqual([]);
  });

  // A sweep that cannot fail is worthless — prove it fails where it must.
  const [branch, cloud, , hooks, org] = R5_LITERALS;
  it("fails on a literal planted in a shell helper", () => {
    expect(sweepLiterals("x.sh", `git pull origin ${branch}\n`)).toEqual([`x.sh:1: ${branch}`]);
  });

  it("fails on a literal inside DEFAULTS — there is no DEFAULTS exemption", () => {
    const src = ["export const DEFAULTS = {", `  baseBranch: "${branch}",`, "};", ""].join("\n");
    expect(sweepLiterals("config.mjs", src)).toEqual([`config.mjs:2: ${branch}`]);
  });

  it("honors no marker comment and no marked fence", () => {
    expect(sweepLiterals("x.mjs", `// source-literal-ok: ${cloud}_outputs.json`)).toEqual([`x.mjs:1: ${cloud}`]);
    const doc = ["On source defaults that is:", "```bash", `bash scripts/${hooks}/x.sh`, "```"].join("\n");
    expect(sweepLiterals("SKILL.md", doc)).toEqual([`SKILL.md:3: ${hooks}`]);
  });

  it("matches case-insensitively and flags vitest only as a check name", () => {
    expect(sweepLiterals("x.json", `"owner": "${org[0].toUpperCase()}${org.slice(1)}"`)).toEqual([`x.json:1: ${org}`]);
    expect(sweepLiterals("x.mjs", 'checks: { required: ["vitest"] }')).toEqual(["x.mjs:1: vitest"]);
    expect(sweepLiterals("x.test.mjs", 'import { it } from "vitest";', { checkNames: false })).toEqual([]);
  });
});

// --- config threading at the production call sites (KTD1) --------------------
//
// These functions keep DEFAULTS-valued parameter defaults so tests can call them
// bare, which is worth keeping. The risk that buys is a PRODUCTION call site that
// omits the argument and silently judges a repo by the defaults instead of its
// config — no error, just the wrong answers. Making the parameters required would cost ~50
// unrelated test edits, so this is the static stand-in: run.mjs is the only file
// holding production call sites, so read its source and require every call to
// hand the loaded config down.
//
// deriveLaneState is threaded in two steps — computeSpineStatus takes
// `checks: pmConfig().checks` and passes `previewContext` on from it — so pinning
// both halves covers the path. isGreen has no direct call site today (it is
// reached through deriveLaneState); its entry guards the first one to appear.
const CONFIG_ARG = {
  isGreen: /previewContext|pmConfig\(\)/,
  deriveLaneState: /previewContext/,
  deriveChecksFromRollup: /pmConfig\(\)\.checks/,
  computeSpineStatus: /checks:\s*pmConfig\(\)\.checks/,
  evaluateChecklist: /policy:\s*pmConfig\(\)\.subjects[\s\S]*protectedPaths:\s*\[\s*\.\.\.pmConfig\(\)\.protectedPaths/,
  resolveLanePr: /baseBranch/,
  selectIssues: /dangerPaths:\s*pmConfig\(\)\.dangerPaths/,
  postMergeBar: /pmConfig\(\)/,
  renderWorkerPrompt: /pmConfig\(\)/,
};

// Return the argument text of every CALL to `name` (the `function name(` that
// defines it is not one). ponytail: depth counter over raw source — no string or
// comment awareness, because none of these calls carries a parenthesis inside a
// string literal, and a prose mention never puts `(` straight after the name. If
// one ever does, parse the file instead of scanning it.
function callArgs(src, name) {
  const calls = [];
  for (const m of src.matchAll(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, "g"))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        calls.push(src.slice(open + 1, i));
        break;
      }
    }
  }
  return calls;
}

describe("run.mjs hands the loaded config to every config-bearing call (KTD1)", () => {
  const RUN = read("run.mjs");

  it.each(Object.keys(CONFIG_ARG))("every %s call in run.mjs carries its config argument", (name) => {
    for (const args of callArgs(RUN, name)) {
      expect(args, `run.mjs calls ${name}(${args}) — no pmConfig()-derived argument, so a repo gets the defaults instead of its config`).toMatch(
        CONFIG_ARG[name],
      );
    }
  });

  // A guard that cannot fail is worthless — prove both directions.
  it("rejects a call that drops the config argument", () => {
    const dropped = callArgs("const c = deriveChecksFromRollup(pr.statusCheckRollup);", "deriveChecksFromRollup");
    expect(dropped).toEqual(["pr.statusCheckRollup"]);
    expect(dropped[0]).not.toMatch(CONFIG_ARG.deriveChecksFromRollup);
  });

  it("accepts the threaded call and ignores the definition", () => {
    const src = [
      "export function deriveChecksFromRollup(rollup = [], checks = DEFAULTS.checks) {",
      "  const c = deriveChecksFromRollup(pr.statusCheckRollup, pmConfig().checks);",
    ].join("\n");
    const found = callArgs(src, "deriveChecksFromRollup");
    expect(found).toEqual(["pr.statusCheckRollup, pmConfig().checks"]);
    expect(found[0]).toMatch(CONFIG_ARG.deriveChecksFromRollup);
  });
});
