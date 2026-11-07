import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import { lint } from "../../skills/ko-acceptance-validator/scripts/gherkin.mjs";
import { absoluteHits, linkProblems, PRIVATE, sha, sweepPrivate } from "../private-sweep.mjs";

// Repo-level guards for the acceptance validator. They do not ship with the skill.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SKILL = join(ROOT, "skills/ko-acceptance-validator");
const PLAN = join(ROOT, "docs/plans/2026-11-07-0816-feat-acceptance-validator-skill-plan.md");
const README = join(ROOT, "README.md");
const FIXTURES = join(HERE, "fixtures");

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);
const SKILL_FILES = walk(SKILL);
const TEST_FILES = walk(HERE);

// Names this skill must never carry: where it came from, stored only as SHA-256 of the lowercased token.
const SOURCE_NAMES = new Set([
  "cbe370481704cef068c18bdcbe262329c59824d6c87e96510a53f022e899ab04",
  "91b6da07adf530f8a9710301b4fd94c3828058e4942a68e48627dc28c6688778",
  "29e60c5e58d13ce60ed5364db1b76a374c799e5b371333cc8c2d2605c21560a8",
  "ebfff902948d5dd833c6edb82f97563a3ebb1ce9fa89c37d713cd5836169ab3b",
  "74f8b187fcc4e194881c59f85fde8f03438ecf41ee7db52a93c8d103bd86a0b0",
  "55f83af98ca9393690d40f656f7dd955d3a0e59c761a07974f213b300dc42aee",
  "9ed1515819dec61fd361d5fdabb57f41ecce1a5fe1fe263b98c0d6943b9b232e",
  "58405264f73a9f2e4269d55dcd3de654d8f13a3c6f60c652536e397ff68478bd",
  "9ce00b27299cbd844c8a86508251fcdde9d040b9b1681ffd088580d489510628",
  "2ab871c9fd15d13fa3f4552baec2c2228ce79e120eb0c530eea4f0b2141787ee",
  "2b277f396c330786c75b8596ba0bd0c9794fe136eb1d9522f84042d6c48d4aed",
  "682fbae20f3428bcec4c117c57bea18d438c4758d972909b41dbe22884e0d6b8",
]);
// Other skills and tools it must not require. Only the skill is held to this: the README documents other skills, and a plan's metadata names its planner.
const REQUIRED_TOOL_NAMES = new Set([
  "2ec0a98b029698b471a83e5327c932df95c78dd5a177df80e0d9b28bde66d7aa",
  "6aa298eac3bff0669b6cfa5d3d79ba929f584a062443ad0c46f6aa8b6dfaf0b0",
  "7f18c9a72274b7cd4085db0a72fe279e51d2210d48ab32783b383be75b44928d",
  "56543dd95d17444dd93191bdd1660b8b9eb0c9d3577116bae692993b4fc92bc5",
  "10c0f7cd73fb54a4f7254be5d7b9f9527839b93d4295333c6e74bf9ab70f1894",
  "8cd28e52bfee04c5c7d62f4bfc8f12626970facbaa8e225c02510f56cf285ab7",
  "310bccc8f9a21a64f95fee239e046aee4a220379de8128541d0d6df7b0d685ea",
]);
const ALL_NAMES = new Set([...PRIVATE, ...SOURCE_NAMES]);
const STRICT_NAMES = new Set([...ALL_NAMES, ...REQUIRED_TOOL_NAMES]);

describe("the skill names no project, vendor or required tool", () => {
  it.each([...SKILL_FILES, ...TEST_FILES].map(rel))("%s is clean", (f) => {
    expect(sweepPrivate(f, read(join(ROOT, f)), STRICT_NAMES)).toEqual([]);
  });

  it.each([PLAN, README].map(rel))("%s names no source project", (f) => {
    expect(sweepPrivate(f, read(join(ROOT, f)), ALL_NAMES)).toEqual([]);
  });

  it("catches a planted name with its file and line, ignoring case", () => {
    expect(sweepPrivate("x.md", "ok\nSee ZebraCorp here\n", new Set([sha("zebracorp")]))).toEqual(["x.md:2"]);
  });

  it("stores the names only as hashes", () => {
    for (const h of STRICT_NAMES) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("no absolute local path", () => {
  it.each([...SKILL_FILES, ...TEST_FILES, PLAN, README].map(rel))("%s", (f) => {
    expect(absoluteHits(f, read(join(ROOT, f)))).toEqual([]);
  });
});

const IMPORTS = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const foreignImports = (src) => [...src.matchAll(IMPORTS)].map((m) => m[1]).filter((spec) => !spec.startsWith("./") && !spec.startsWith("node:"));

describe("every shipped script runs with no install", () => {
  const scripts = SKILL_FILES.filter((f) => f.endsWith(".mjs"));

  it("finds the scripts", () => {
    expect(scripts.length).toBeGreaterThanOrEqual(5);
  });

  it.each(scripts.map(rel))("%s imports only siblings and node: builtins", (f) => {
    expect(foreignImports(read(join(ROOT, f)))).toEqual([]);
  });

  it("catches a bare dependency and a path out of the folder", () => {
    expect(foreignImports('import x from "yaml";\nimport y from "../z.mjs";\nimport "./ok.mjs";\nimport { a } from "node:fs";')).toEqual(["yaml", "../z.mjs"]);
  });

  it("ships no test file a consumer's runner could pick up", () => {
    expect(SKILL_FILES.filter((f) => /\.test\.|__fixtures__/.test(f))).toEqual([]);
  });
});

describe("every relative link resolves inside the skill", () => {
  it.each(SKILL_FILES.filter((f) => f.endsWith(".md")).map(rel))("%s", (f) => {
    expect(linkProblems(join(ROOT, f), read(join(ROOT, f)), SKILL)).toEqual([]);
  });
});

const official = (text) => new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher()).parse(text);
const fixtures = (dir) => readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith(".feature"));
const fixture = (dir, f) => read(join(FIXTURES, dir, f));

describe("the shipped lint against the official Gherkin parser", () => {
  it.each(fixtures("valid"))("valid/%s is accepted by both", (f) => {
    expect(() => official(fixture("valid", f))).not.toThrow();
    expect(lint(fixture("valid", f)).ok).toBe(true);
  });

  it.each(fixtures("invalid-syntax"))("invalid-syntax/%s is rejected by both", (f) => {
    expect(() => official(fixture("invalid-syntax", f))).toThrow();
    const { ok, errors } = lint(fixture("invalid-syntax", f));
    expect(ok).toBe(false);
    for (const e of errors) expect(e.line).toBeGreaterThan(0);
  });

  it.each(fixtures("invalid-contract"))("invalid-contract/%s is accepted by the official parser and rejected by the lint", (f) => {
    expect(() => official(fixture("invalid-contract", f))).not.toThrow();
    const { ok, errors } = lint(fixture("invalid-contract", f));
    expect(ok).toBe(false);
    for (const e of errors) expect(e.line).toBeGreaterThan(0);
  });
});

describe("the reference exemplars are real", () => {
  const blocks = walk(join(SKILL, "references")).flatMap((f) => [...read(f).matchAll(/^```gherkin\n([\s\S]*?)^```/gm)].map((m) => [rel(f), m[1]]));

  it("finds the exemplars", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it.each(blocks)("%s lints clean and the official parser accepts it", (_, text) => {
    expect(lint(text).errors).toEqual([]);
    expect(() => official(text)).not.toThrow();
  });
});
