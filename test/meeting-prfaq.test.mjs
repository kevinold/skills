import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Cross-skill guards for meeting-notes and prfaq. This file lives outside both
// skill folders so consumers never install it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["meeting-notes", "prfaq"].map((s) => join(ROOT, "skills", s));
const PLAN = join(ROOT, "docs/plans/2026-09-30-0939-feat-meeting-notes-prfaq-skills-plan.md");
const README = join(ROOT, "README.md");

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const FILES = SKILLS.flatMap(walk);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);

// --- Private-literal sweep ----------------------------------------------------
//
// Names from the private repos these skills were extracted from: orgs, products,
// people, seed tenants, vendors, hosts, internal tags. Stored only as SHA-256 of
// the lowercased token — base64 or plaintext would publish the very names the
// guard keeps out of this public repo.
const PRIVATE = new Set([
  "796472345404ddcac9393b32f02481244ebbe03a2f6b52f903d4d1c2123eb662",
  "be17d9686c8bfa2e37988b4e9a87e25a2078f1edaea071b56ad59d73ab31220a",
  "2b277f396c330786c75b8596ba0bd0c9794fe136eb1d9522f84042d6c48d4aed",
  "8a7feb4abff5cc24d4e8c8971133606b7e84f4d1076ed0b5c65d69379f1f11bb",
  "91b6da07adf530f8a9710301b4fd94c3828058e4942a68e48627dc28c6688778",
  "80b1f269955ba50701d2070eb6b43fddaed7b3bdda9ed7afb5e0c1a483e425cc",
  "4455138c4b5ea68d9a4e99694c50b9a51b292350fabd5e9aec450213f79b578f",
  "ee163e0b6b0749d28782eeb94c8f197339da2b62b9ad6791bdf598e3670fe16d",
  "adc17a68f3fc0f46483c8f815fae86d74409fc27c0829b4d9ed6cdc0e3b3fdfa",
  "4626cd1a3e6d10aa8a50bf96dfea04637f3993c723a7d42ec0a77892572f7d6b",
  "f0bacd14b144f4a253b13c5972479678b8b5e138b4f3cd65b150d675a1207e5a",
  "dcd519d47e3e6ecc3e9623cd0ecc6ff5d78b01ffbb00b953a47b93d691db7f20",
  "23504ac853a0404ad6ca67f7494eb3008ad7d2b24c09cc3793c6b2095fd66c78",
  "cea6111b56f82e1e38f87e7d891e6798879cf82f1eb88134981e305e61211a1f",
  "436daa0647b28d2fe38c71bc48657b415ee0c8ebebd060642fea5c7b83641913",
  "246f2e285d6413c1b32093e3a04751e0b86654c8d23ad34305096ac402fd1660",
  "af6db6cf20f30a7ad7fae60c1917c306c5033c213dee0a49013ac67d34235ebe",
  "b3604a27dcf304c8a8f916573ec79aaf60065476b99573c453ad834988f4ad56",
  "61548bf1da865037dc424e3dbcea3e703edbf2fa87b0c7a85f1cc1cb547fdb58",
  "f26ebb8c857cb112ae370dd8ae3331f1fa8a5f5331216824948430625ccc0741",
  "7f1282974437f511dacee4013a0814bf7cbab38dd07040a4b4a82cebd50d134e",
  "e23e111961d315b688651c65239408ea9af5e1db0da94dc075f32bb9e8280450",
  "14cdf7df4611a6f9342dd0c29a5675109a360b15d3295f9e1fbf6d7d9a9e2228",
  "2d15769d0f047e8d061608373004d89c147e13c4e3241c35b640b8145f934f3b",
  "e972c55ef0fae6fd36f07cddb3fbc712698f5ea8b6dfaa2fa5fcca8c78af76f3",
  "460e4626ea68653e1bf63672f444d8821c7402a09514a57a4fc0268b8e4b5622",
]);

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Every 1-, 2- and 3-word window of a line, lowercased and split on non-alphanumerics.
const ngrams = (line) => {
  const w = line.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" "));
  return out;
};

// `name:lineNo` for every line of `src` that `pred` matches.
const lineHits = (name, src, pred) => src.split("\n").flatMap((l, i) => (pred(l) ? [`${name}:${i + 1}`] : []));

export const sweepPrivate = (name, src, hashes = PRIVATE) =>
  lineHits(name, src, (l) => ngrams(l).some((g) => hashes.has(sha(g))));

describe("no private-source name in the skills or this plan (R3)", () => {
  it.each([...FILES, PLAN, README].map(rel))("%s is clean", (f) => {
    expect(sweepPrivate(f, read(join(ROOT, f)))).toEqual([]);
  });

  it("stores the list only as hashes", () => {
    expect(PRIVATE.size).toBeGreaterThan(0);
    for (const h of PRIVATE) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  const planted = new Set([sha("zebracorp"), sha("ada quill")]);
  it("fails on a planted single-word name, ignoring case", () => {
    expect(sweepPrivate("x.md", "ok\nSee ZebraCorp's deal\n", planted)).toEqual(["x.md:2"]);
  });

  it("fails on a planted two-word name split by punctuation", () => {
    expect(sweepPrivate("x.md", "(Ada-Quill, ~3:10)", planted)).toEqual(["x.md:1"]);
  });

  it("does not flag a partial word", () => {
    expect(sweepPrivate("x.md", "zebracorporation adaquill", planted)).toEqual([]);
  });
});

// --- Shared promotion bar (R4, KTD1) -------------------------------------------

describe("promotion bar is identical in both skills (R4)", () => {
  it("byte-equal copies", () => {
    const [a, b] = SKILLS.map((s) => readFileSync(join(s, "references/prfaq-promotion-bar.md")));
    expect(a.equals(b)).toBe(true);
  });
});

// --- Status legend (R5, KD4) ---------------------------------------------------

const RETIRED_STATUS = /\*\*(LIVE|ROADMAP)\*\*|chip (live|road)\b|road-row/;
export const retiredStatusHits = (name, src) => lineHits(name, src, (l) => RETIRED_STATUS.test(l));

describe("status legend is BUILT/PARTIAL/PLANNED only (R5)", () => {
  it.each(FILES.map(rel))("%s uses no LIVE/ROADMAP marker", (f) => {
    expect(retiredStatusHits(f, read(join(ROOT, f)))).toEqual([]);
  });

  it("fails on a retired marker", () => {
    expect(retiredStatusHits("x.md", "| Search | 🟢 **LIVE** | `src/` |\n| B | 🔵 **ROADMAP** | — |")).toEqual(["x.md:1", "x.md:2"]);
    expect(retiredStatusHits("x.html", '<span class="chip road">')).toEqual(["x.html:1"]);
  });

  it("allows prose that warns against LIVE", () => {
    expect(retiredStatusHits("x.md", 'never label something "LIVE" unless it truly is')).toEqual([]);
  });
});

// --- No absolute paths ---------------------------------------------------------

const ABSOLUTE = /\/Users\/|\/home\/[a-z]|file:\/\/\/|[A-Z]:\\Users\\/;
export const absoluteHits = (name, src) => lineHits(name, src, (l) => ABSOLUTE.test(l));

describe("no absolute local paths in the skills", () => {
  it.each([...FILES, README].map(rel))("%s", (f) => {
    expect(absoluteHits(f, read(join(ROOT, f)))).toEqual([]);
  });

  it("fails on /Users/ and file:/// paths", () => {
    expect(absoluteHits("x.md", "Source: /Users/pat/rec.mp4\nok\nfile:///tmp/a.html")).toEqual(["x.md:1", "x.md:3"]);
  });
});

// --- Links resolve inside the skill (R2) --------------------------------------
//
// Markdown links and HTML hrefs outside code and comments. External URLs are
// skipped; `<...>` placeholder targets are template slots and are exempt.

const stripCode = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");

export function linkProblems(file, src, skillDir) {
  const body = stripCode(src);
  const targets = [
    ...[...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
  ];
  const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const problems = [];
  for (const t of targets) {
    if (/^(https?:|mailto:)/.test(t) || /[<>]/.test(t)) continue;
    if (t.startsWith("#")) {
      if (file.endsWith(".html") && !ids.has(t.slice(1))) problems.push(`${t} has no matching id`);
      continue;
    }
    const target = resolve(dirname(file), t.split("#")[0]);
    if (relative(skillDir, target).startsWith("..")) problems.push(`${t} leaves the skill`);
    else if (!existsSync(target)) problems.push(`${t} does not exist`);
  }
  return problems;
}

describe("every link resolves inside its own skill (R2)", () => {
  for (const skill of SKILLS) {
    it.each(FILES.filter((f) => f.startsWith(skill + "/") && /\.(md|html)$/.test(f)).map(rel))("%s", (f) => {
      expect(linkProblems(join(ROOT, f), read(join(ROOT, f)), skill)).toEqual([]);
    });
  }

  const skill = SKILLS[0];
  const file = join(skill, "SKILL.md");
  it("fails on a concrete link out of the skill", () => {
    expect(linkProblems(file, "[x](../prfaq/SKILL.md)", skill)).toEqual(["../prfaq/SKILL.md leaves the skill"]);
  });

  it("fails on a missing file and a dangling HTML anchor", () => {
    expect(linkProblems(file, "[x](./references/nope.md)", skill)).toEqual(["./references/nope.md does not exist"]);
    expect(linkProblems(join(skill, "x.html"), '<a href="#b">B</a><section id="a">', skill)).toEqual(["#b has no matching id"]);
  });

  it("exempts placeholder targets, code and comments", () => {
    const src = "[S](<sibling>-prfaq.md) `[x](../y.md)`\n<!-- <a href=\"#id\"> -->\n```\n[x](../z.md)\n```";
    expect(linkProblems(file, src, skill)).toEqual([]);
  });
});
