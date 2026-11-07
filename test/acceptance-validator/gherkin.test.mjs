import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lint, listScenarios, slug } from "../../skills/ko-acceptance-validator/scripts/gherkin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SCRIPT = resolve(HERE, "../../skills/ko-acceptance-validator/scripts/gherkin.mjs");
const fixture = (rel) => readFileSync(join(FIXTURES, rel), "utf8");
const names = (dir) => readdirSync(join(FIXTURES, dir)).filter((f) => f.endsWith(".feature"));
const scenario = (tags, name = "Case", steps = ["Given a", "When b", "Then c"]) =>
  `Feature: F\n\n  ${tags}\n  Scenario: ${name}\n${steps.map((s) => `    ${s}`).join("\n")}\n`;
const GOOD = "@kind:good @dimension:workflow-fit @route:/orders";

describe("lint accepts the valid fixtures", () => {
  it.each(names("valid"))("%s", (f) => {
    expect(lint(fixture(`valid/${f}`)).errors).toEqual([]);
  });
});

describe("lint rejects invalid fixtures with a line number", () => {
  it.each([...names("invalid-syntax").map((f) => `invalid-syntax/${f}`), ...names("invalid-contract").map((f) => `invalid-contract/${f}`)])("%s", (f) => {
    const { ok, errors } = lint(fixture(f));
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.line).toBeGreaterThan(0);
  });
});

describe("syntax errors point at the offending line", () => {
  it("a hard-wrapped step yields exactly one error at the wrapped line", () => {
    const { errors } = lint(fixture("invalid-syntax/hard-wrapped-step.feature"));
    expect(errors.map((e) => e.line)).toEqual([8]);
  });

  it("a benefit line used as a step yields one error at that line", () => {
    expect(lint(fixture("invalid-syntax/so-line.feature")).errors.map((e) => e.line)).toEqual([8]);
  });

  it("a file with no Feature line yields one error at line 1", () => {
    expect(lint(fixture("invalid-syntax/no-feature.feature")).errors.map((e) => e.line)).toEqual([1]);
  });

  it("an empty file is an error", () => {
    expect(lint("").ok).toBe(false);
  });

  it("a non-English language header yields one error at that line", () => {
    expect(lint(fixture("invalid-contract/language-fr.feature")).errors.map((e) => e.line)).toEqual([1]);
  });

  it("reports only syntax errors while the file does not parse", () => {
    const text = "Feature: F\n\n  Scenario: No tags at all\n    Given a\n    wrapped\n    Then c\n";
    expect(lint(text).errors.map((e) => e.line)).toEqual([5]);
  });

  it("a Scenario Outline yields one error at its line", () => {
    expect(lint(fixture("invalid-contract/scenario-outline.feature")).errors.map((e) => e.line)).toEqual([4]);
  });
});

describe("the tag contract", () => {
  it("two scenarios whose names slug the same yield one error at the second", () => {
    expect(lint(fixture("invalid-contract/duplicate-slug.feature")).errors.map((e) => e.line)).toEqual([10]);
  });

  it("a scenario with Then but no When is ok with one warning", () => {
    const { ok, errors, warnings } = lint(fixture("valid/no-when.feature"));
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([{ line: 4, message: expect.stringMatching(/When/) }]);
  });

  it("a Background Given satisfies a scenario with no Given of its own", () => {
    expect(lint(fixture("valid/orders.feature")).warnings).toEqual([]);
  });

  it("a Then-less scenario errors even with an And after a When", () => {
    expect(lint(scenario(GOOD, "Case", ["Given a", "When b", "And c"])).ok).toBe(false);
  });

  it("And and But take the type of the step before them", () => {
    expect(lint(scenario(GOOD, "Case", ["Given a", "When b", "Then c", "But d"])).warnings).toEqual([]);
  });

  it.each(["/orders/:id", "/admin#team", "/a?b=c&d=%20", "/"])("accepts the route %s", (r) => {
    expect(lint(scenario(`@kind:good @dimension:legibility @route:${r}`)).errors).toEqual([]);
  });

  it.each(["//host/x", "orders", "/x$(y)", "/x;y", "/x`y`", "/x|y", "/x'y", '/x"y', "/x\\y"])("rejects the route %s", (r) => {
    expect(lint(scenario(`@kind:good @dimension:legibility @route:${r}`)).ok).toBe(false);
  });
});

describe("tags follow Gherkin inheritance", () => {
  const [first, emptyHistory, reorder, receipt] = listScenarios(fixture("valid/orders.feature"));

  it("a feature-level route reaches every scenario", () => {
    expect(first.routes).toEqual(["/orders", "/orders/:id"]);
    expect(emptyHistory.routes).toEqual(["/orders"]);
    expect(reorder.routes).toEqual(["/orders", "/checkout"]);
    expect(receipt.routes).toEqual(["/orders", "/admin#orders"]);
  });

  it("a route inside a comment never counts", () => {
    const all = listScenarios(fixture("valid/orders.feature")).flatMap((s) => s.routes);
    expect(all).not.toContain("/ghost");
  });

  it("the comment-above-a-tag case lists only the real route", () => {
    const text = "Feature: F\n\n  # @route:/ghost\n  @kind:good @dimension:legibility @route:/x\n  Scenario: S\n    Given a\n    When b\n    Then c\n";
    expect(listScenarios(text)[0].routes).toEqual(["/x"]);
  });

  it("a trailing comment on a tag line is not a tag", () => {
    const text = "Feature: F\n\n  @kind:good @dimension:legibility @route:/x #@route:/ghost\n  Scenario: S\n    Given a\n    When b\n    Then c\n";
    expect(listScenarios(text)[0].routes).toEqual(["/x"]);
  });

  it("a rule-level tag reaches only that rule's scenarios", () => {
    const text = [
      "Feature: F",
      "  @kind:good @dimension:legibility @route:/a",
      "  Scenario: Outside",
      "    Given a",
      "    When b",
      "    Then c",
      "  @route:/rule",
      "  Rule: R",
      "    @kind:good @dimension:legibility @route:/b",
      "    Scenario: Inside",
      "      Given a",
      "      When b",
      "      Then c",
      "",
    ].join("\n");
    const [outside, inside] = listScenarios(text);
    expect(outside.routes).toEqual(["/a"]);
    expect(inside.routes).toEqual(["/rule", "/b"]);
  });
});

describe("listScenarios", () => {
  const text = fixture("valid/orders.feature");

  it("lists id, name, kind, dimension, routes, steps and line", () => {
    expect(listScenarios(text)[0]).toEqual({
      id: "reorder-starts-from-the-order-i-am-looking-at",
      name: "Reorder starts from the order I am looking at",
      kind: "good",
      dimension: "workflow-fit",
      routes: ["/orders", "/orders/:id"],
      steps: [
        { keyword: "Given", text: "I am signed in to my account" },
        { keyword: "When", text: 'I open a past order and choose "Order again"' },
        { keyword: "Then", text: "a new order holds the same items" },
        { keyword: "And", text: "I land on checkout" },
      ],
      line: 13,
    });
  });

  it("filters by kind, route and dimension together", () => {
    expect(listScenarios(text, { kind: "bad" }).map((s) => s.id)).toEqual(["an-empty-history-reads-like-a-failure"]);
    expect(listScenarios(text, { route: "/checkout" }).map((s) => s.kind)).toEqual(["good"]);
    expect(listScenarios(text, { dimension: "legibility", route: "/orders" })).toHaveLength(1);
    expect(listScenarios(text, { kind: "bad", route: "/checkout" })).toEqual([]);
  });

  it("puts Background steps first", () => {
    for (const s of listScenarios(text)) expect(s.steps[0]).toEqual({ keyword: "Given", text: "I am signed in to my account" });
  });
});

describe("slug", () => {
  it("lowercases and folds non-alphanumeric runs to single dashes, trimmed", () => {
    expect(slug("  Open the order!  ")).toBe("open-the-order");
    expect(slug("A -- b_c")).toBe("a-b-c");
  });
});

describe("the CLI", () => {
  const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });

  it("lint prints JSON and exits 0 on a valid file", () => {
    const r = cli("lint", join(FIXTURES, "valid/orders.feature"));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it("lint exits 1 and names the line on an invalid file", () => {
    const r = cli("lint", join(FIXTURES, "invalid-syntax/hard-wrapped-step.feature"));
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).errors[0].line).toBe(8);
  });

  it("scenarios honors its filters", () => {
    const r = cli("scenarios", join(FIXTURES, "valid/orders.feature"), "--kind", "bad", "--route", "/orders");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).map((s) => s.kind)).toEqual(["bad"]);
  });

  it("scenarios on an invalid file prints the lint errors and exits 1", () => {
    const r = cli("scenarios", join(FIXTURES, "invalid-syntax/no-feature.feature"));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/1:/);
  });

  it("an unknown command exits 2", () => {
    expect(cli("nope").status).toBe(2);
  });
});
