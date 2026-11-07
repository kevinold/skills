#!/usr/bin/env node
// A small Gherkin reader for the shared .feature artifact, with no dependencies so
// it runs from an installed skill folder. It accepts a strict subset: anything it
// passes, the official Gherkin parser also passes. The reverse need not hold.
//
// ponytail: English keywords and no Scenario Outline. One scenario id cannot show
// every Examples row was observed, so each case is written as its own Scenario.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = ["good", "bad"];
export const DIMENSIONS = ["workflow-fit", "legibility", "intent-match", "convention-fit"];

// A path-only reference. Refuses scheme-relative values, which would leave the
// target host, and shell metacharacters, because a route may reach a command line.
const ROUTE = /^\/(?!\/)[A-Za-z0-9._~:/?=&%#-]*$/;
const STEP = /^(Given|When|Then|And|But|\*) +(.*)$/;
const LANGUAGE = /^#\s*language\s*:\s*([a-zA-Z_-]+)\s*$/;
const DOC_STRING = /^("""|```)/;

export const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Count a table row's cells. `\|` is a literal pipe and `\\` a literal backslash, as
// in the official parser.
function tableCellCount(line) {
  let cells = 0;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") cells++;
  }
  return cells;
}

// The tags on a line, or the reason it is malformed.
function parseTags(line) {
  const uncommented = line.split(/\s#/, 1)[0];
  const parts = uncommented.split("@").slice(1).map((t) => t.trim());
  if (parts.some((t) => /\s/.test(t))) return { error: "a tag may not contain whitespace" };
  return { tags: parts.filter(Boolean) };
}

/** Parse the file into its feature and scenarios. `errors` holds syntax errors only. */
export function parse(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const errors = [];
  const fail = (line, message) => errors.push({ line, message });

  let feature = null;
  const scenarios = [];
  const featureBackground = { steps: [] };
  let ruleBackground = null;
  let ruleTags = [];
  let pendingTags = [];
  let pendingTagLine = 0;
  let block = null; // "feature" | "rule" | "background" | "scenario"
  let blockSteps = null;
  let inSteps = false;
  let afterStep = false; // the last content line was a step, so an argument may follow
  let sawChildren = false; // a Scenario or Rule has started under the feature
  let sawRuleScenario = false;
  let hadFeatureBackground = false;
  let hadRuleBackground = false;
  let inRule = false;
  let tableWidth = null;
  let lastStepType = null;
  let languageAllowed = true;

  const takeTags = () => {
    const t = pendingTags;
    pendingTags = [];
    pendingTagLine = 0;
    return t;
  };
  const closeBlock = () => {
    afterStep = false;
    inSteps = false;
    tableWidth = null;
    lastStepType = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i].trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      const lang = languageAllowed && line.match(LANGUAGE);
      if (lang && lang[1] !== "en") {
        fail(n, `only English keywords are supported (found language "${lang[1]}")`);
        return { feature: null, scenarios: [], errors };
      }
      continue;
    }
    languageAllowed = false;

    if (line.startsWith("@")) {
      const { tags, error } = parseTags(line);
      if (error) fail(n, error);
      else pendingTags.push(...tags);
      pendingTagLine = n;
      afterStep = false;
      continue;
    }

    if (line.startsWith("Feature:")) {
      if (feature) {
        fail(n, "a file holds exactly one Feature");
        continue;
      }
      feature = { name: line.slice(8).trim(), tags: takeTags(), line: n };
      block = "feature";
      closeBlock();
      continue;
    }

    if (!feature) {
      // Nothing can be read without a Feature, and every later line would repeat this.
      fail(n, "expected a Feature: line");
      return { feature: null, scenarios: [], errors };
    }

    if (line.startsWith("Rule:")) {
      ruleTags = takeTags();
      ruleBackground = { steps: [] };
      inRule = true;
      sawChildren = true;
      sawRuleScenario = false;
      hadRuleBackground = false;
      block = "rule";
      closeBlock();
      continue;
    }

    if (line.startsWith("Background:")) {
      if (pendingTags.length) {
        fail(pendingTagLine, "a Background takes no tags");
        takeTags();
      }
      const scope = inRule ? hadRuleBackground : hadFeatureBackground;
      if (scope) fail(n, "only one Background is allowed here");
      else if (inRule ? sawRuleScenario : sawChildren) fail(n, "a Background must come before any Scenario");
      if (inRule) hadRuleBackground = true;
      else hadFeatureBackground = true;
      blockSteps = inRule ? ruleBackground.steps : featureBackground.steps;
      block = "background";
      closeBlock();
      continue;
    }

    // The Examples of an already-rejected Outline add nothing to its error.
    if (/^(Examples|Scenarios):/.test(line) && block === "feature") continue;

    if (/^(Scenario Outline|Scenario Template|Examples|Scenarios):/.test(line)) {
      fail(n, `${line.split(":")[0]} is not supported here; write each case as its own Scenario`);
      takeTags();
      block = "feature"; // the rest of an unsupported block is not read
      closeBlock();
      continue;
    }

    const header = line.match(/^(Scenario|Example):(.*)$/);
    if (header) {
      const name = header[2].trim();
      const scenario = {
        id: slug(name),
        name,
        line: n,
        tags: [...new Set([...feature.tags, ...(inRule ? ruleTags : []), ...takeTags()])],
        background: [...featureBackground.steps, ...(inRule ? ruleBackground.steps : [])],
        steps: [],
      };
      scenarios.push(scenario);
      sawChildren = true;
      if (inRule) sawRuleScenario = true;
      blockSteps = scenario.steps;
      block = "scenario";
      closeBlock();
      continue;
    }

    if (pendingTags.length) {
      fail(pendingTagLine, "a tag must sit above a Feature, Rule or Scenario");
      takeTags();
    }

    // Under a Feature or Rule any other line is free description text, as the official parser reads it.
    if (block === "feature" || block === "rule") continue;

    const step = line.match(STEP);
    if (step) {
      const [, keyword, stepText] = step;
      const type = ["Given", "When", "Then"].includes(keyword) ? keyword : lastStepType;
      blockSteps.push({ keyword, text: stepText.trim(), type });
      lastStepType = type;
      inSteps = true;
      afterStep = true;
      tableWidth = null;
      continue;
    }

    if (!inSteps) continue; // description text between a header and its first step

    if (line.startsWith("|") && (afterStep || tableWidth !== null)) {
      const width = tableCellCount(line);
      if (tableWidth !== null && width !== tableWidth) fail(n, "this table row has a different cell count from the row above");
      tableWidth = tableWidth ?? width;
      afterStep = false;
      continue;
    }

    const doc = line.match(DOC_STRING);
    if (doc && afterStep) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === doc[1]) {
          close = j;
          break;
        }
      }
      if (close === -1) {
        fail(n, "this doc string is never closed");
        break;
      }
      i = close;
      afterStep = false;
      continue;
    }

    fail(n, `expected a step keyword (Given, When, Then, And, But, *), got "${line}"; a step stays on one line`);
  }

  if (pendingTags.length) fail(pendingTagLine, "a tag must sit above a Feature, Rule or Scenario");
  if (!feature && errors.length === 0) fail(1, "expected a Feature: line");

  return { feature, scenarios, errors };
}

const tagValues = (tags, prefix) => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));

function shaped(s) {
  return {
    ...s,
    kinds: tagValues(s.tags, "kind:"),
    dimensions: tagValues(s.tags, "dimension:"),
    routes: tagValues(s.tags, "route:"),
    allSteps: [...s.background, ...s.steps],
  };
}

/** Syntax first, then the tag contract. Returns {ok, errors, warnings}, each entry {line, message}. */
export function lint(text) {
  const { feature, scenarios, errors } = parse(text);
  if (errors.length) return { ok: false, errors, warnings: [] };

  const contract = [];
  const warnings = [];
  if (scenarios.length === 0) contract.push({ line: feature.line, message: "a file needs at least one Scenario" });

  const seen = new Set();
  for (const s of scenarios.map(shaped)) {
    const at = (message) => contract.push({ line: s.line, message: `${message} (scenario "${s.name}")` });
    if (s.kinds.length !== 1) at("needs exactly one @kind tag");
    else if (!KINDS.includes(s.kinds[0])) at(`@kind must be ${KINDS.join(" or ")}, got "${s.kinds[0]}"`);
    if (s.dimensions.length !== 1) at("needs exactly one @dimension tag");
    else if (!DIMENSIONS.includes(s.dimensions[0])) at(`@dimension must be one of ${DIMENSIONS.join(", ")}, got "${s.dimensions[0]}"`);
    if (s.routes.length === 0) at("needs at least one @route tag");
    for (const r of s.routes) if (!ROUTE.test(r)) at(`@route must be a path-only reference, got "${r}"`);
    if (!s.id) at("needs a name");
    else if (seen.has(s.id)) at(`repeats the scenario id "${s.id}" in this file`);
    seen.add(s.id);

    const types = s.allSteps.map((step) => step.type);
    if (!types.includes("Then")) at("needs at least one Then step");
    if (!types.includes("Given")) warnings.push({ line: s.line, message: `has no Given step (scenario "${s.name}")` });
    if (!types.includes("When")) warnings.push({ line: s.line, message: `has no When step (scenario "${s.name}")` });
  }

  return { ok: contract.length === 0, errors: contract, warnings };
}

/** The scenarios as a coding agent reads them, Background steps first. */
export function listScenarios(text, { route, kind, dimension } = {}) {
  return parse(text)
    .scenarios.map(shaped)
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kinds[0],
      dimension: s.dimensions[0],
      routes: s.routes,
      steps: s.allSteps.map(({ keyword, text: stepText }) => ({ keyword, text: stepText })),
      line: s.line,
    }))
    .filter((s) => (!route || s.routes.includes(route)) && (!kind || s.kind === kind) && (!dimension || s.dimension === dimension));
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  if (!["lint", "scenarios"].includes(cmd) || !file) {
    process.stderr.write("usage: gherkin.mjs lint <file> | scenarios <file> [--route x] [--kind y] [--dimension z]\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const result = lint(text);
  if (cmd === "lint") {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`${e.line}: ${e.message}\n`);
    return 1;
  }
  const filters = { route: flag("--route"), kind: flag("--kind"), dimension: flag("--dimension") };
  process.stdout.write(JSON.stringify(listScenarios(text, filters), null, 2) + "\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
