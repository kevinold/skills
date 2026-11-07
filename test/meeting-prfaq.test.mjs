import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { absoluteHits, lineHits, linkProblems, PRIVATE, sha, sweepPrivate } from "./private-sweep.mjs";

// Cross-skill guards for meeting-notes and prfaq. This file lives outside both
// skill folders so consumers never install it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["ko-meeting-notes", "ko-prfaq"].map((s) => join(ROOT, "skills", s));
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
