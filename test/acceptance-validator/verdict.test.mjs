import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashArtifact, judgeFingerprint, validate, compose, persist, topLevelFromRecorded, fingerprintKey } from "../../skills/ko-acceptance-validator/scripts/verdict.mjs";

const NOW = "2026-09-16T12:00:00.000Z";
const SHA = "abc1234def5678";
const FP = "model-x@0f1e2d3c4b5a";
const scenarioText = (tags, name) => `  ${tags}\n  Scenario: ${name}\n    Given a\n    When b\n    Then c\n`;
const ARTIFACT = [
  "Feature: Reorder\n",
  scenarioText("@kind:good @dimension:workflow-fit @route:/orders", "g1"),
  scenarioText("@kind:good @dimension:legibility @route:/orders", "g2"),
  scenarioText("@kind:good @dimension:intent-match @route:/orders", "g3"),
  scenarioText("@kind:bad @dimension:convention-fit @route:/orders", "b1"),
].join("\n");

// A fully-valid build draft; override any slice per test.
function buildDraft(overrides = {}) {
  return {
    stage: "build",
    artifact_path: "docs/plans/x.feature",
    target_url: "http://localhost:5173/orders",
    dimensions: {
      "workflow-fit": { status: "PASS", findings: [], evidence: ["wf.png"] },
      legibility: { status: "PASS", findings: [], evidence: ["leg.png"] },
      "intent-match": { status: "PASS", findings: [], evidence: ["intent.png"] },
      "convention-fit": { status: "PASS", findings: [], evidence: ["conv.png"] },
    },
    routes: [{ route: "/orders", result: "Pass", reason: "" }],
    scenarios: [
      { id: "g1", kind: "good", dimension: "workflow-fit", route: "/orders", status: "held" },
      { id: "g2", kind: "good", dimension: "legibility", route: "/orders", status: "held" },
      { id: "g3", kind: "good", dimension: "intent-match", route: "/orders", status: "held" },
      { id: "b1", kind: "bad", dimension: "convention-fit", route: "/orders", status: "held" },
    ],
    ...overrides,
  };
}
// A manifest bound to this run: verified, same sha + artifact_hash, route table ⊇ routes[] (A2).
const MANIFEST = { verified: true, sha: SHA, artifact_hash: hashArtifact(ARTIFACT), routes: [{ route: "/orders", result: "Pass" }] };
const buildOpts = { artifactText: ARTIFACT, sha: SHA, fingerprint: FP, manifest: MANIFEST };

function specDraft(dimensions) {
  return { stage: "spec", artifact_path: "docs/plans/x.feature", dimensions, routes: [], scenarios: [] };
}
const specOpts = { artifactText: ARTIFACT, sha: SHA, fingerprint: FP };

describe("hashArtifact", () => {
  it("is stable for identical bytes and changes when one scenario line changes", () => {
    expect(hashArtifact(ARTIFACT)).toBe(hashArtifact(ARTIFACT));
    expect(hashArtifact(ARTIFACT)).not.toBe(hashArtifact(ARTIFACT + "\n  Scenario: extra"));
    expect(hashArtifact(ARTIFACT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("judgeFingerprint", () => {
  it("is deterministic and folds in the model id", () => {
    expect(judgeFingerprint("persona text", "model-x")).toBe(judgeFingerprint("persona text", "model-x"));
    expect(judgeFingerprint("persona text", "model-x")).not.toBe(judgeFingerprint("persona text", "sonnet"));
    expect(judgeFingerprint("persona text", "model-x")).not.toBe(judgeFingerprint("other", "model-x"));
  });
});

describe("validate", () => {
  it("accepts a complete build verdict", () => {
    const v = compose(buildDraft(), buildOpts);
    const res = validate(v);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("accepts an artifact-unavailable unevaluated with artifact_hash null", () => {
    const v = {
      stage: "spec",
      verdict: "unevaluated",
      sha: SHA,
      artifact_hash: null,
      artifact_path: null,
      judge_fingerprint: FP,
      reason: "insufficient-intent: no issue and no request text",
      dimensions: {},
      generated_at: NOW,
    };
    expect(validate(v).ok).toBe(true);
  });

  it("rejects an unknown enum value, naming the field", () => {
    const v = compose(buildDraft(), buildOpts);
    v.verdict = "MAYBE";
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/verdict/);
  });

  it("rejects a missing sha and a missing verdict, each named", () => {
    const noSha = compose(buildDraft(), buildOpts);
    delete noSha.sha;
    expect(validate(noSha).ok).toBe(false);
    expect(validate(noSha).errors.join(" ")).toMatch(/sha/);

    const noVerdict = compose(buildDraft(), buildOpts);
    delete noVerdict.verdict;
    expect(validate(noVerdict).ok).toBe(false);
    expect(validate(noVerdict).errors.join(" ")).toMatch(/verdict/);
  });

  it("rejects an unevaluated without a reason", () => {
    const v = compose(buildDraft(), { ...buildOpts, manifest: undefined }); // → unevaluated
    expect(v.verdict).toBe("unevaluated");
    delete v.reason;
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/reason/);
  });

  it("rejects a non-null artifact_hash on an artifact-unavailable unevaluated", () => {
    const v = {
      stage: "spec",
      verdict: "unevaluated",
      sha: SHA,
      artifact_hash: "deadbeefdeadbeef",
      artifact_path: null,
      judge_fingerprint: FP,
      reason: "insufficient-intent: missing workflow",
      dimensions: {},
      generated_at: NOW,
    };
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/artifact_hash/);
  });

  it("rejects an invalid stage", () => {
    const v = compose(buildDraft(), buildOpts);
    v.stage = "runtime";
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/stage/);
  });

  it("rejects a missing judge_fingerprint", () => {
    const v = compose(buildDraft(), buildOpts);
    delete v.judge_fingerprint;
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/judge_fingerprint/);
  });

  it("rejects a missing generated_at", () => {
    const v = compose(buildDraft(), buildOpts);
    delete v.generated_at;
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/generated_at/);
  });

  it("rejects a non-string artifact_hash", () => {
    const v = compose(buildDraft(), buildOpts);
    v.artifact_hash = 12345;
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/artifact_hash/);
  });

  it("rejects an invalid dimension status enum, naming the dimension", () => {
    const v = compose(buildDraft(), buildOpts);
    v.dimensions.legibility.status = "MEH";
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/legibility/);
  });

  it("rejects an invalid route result enum", () => {
    const v = compose(buildDraft(), buildOpts);
    v.routes = [{ route: "/orders", result: "Maybe" }];
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/route/);
  });

  it("rejects a null artifact_hash on a PASS verdict (null is unevaluated-only)", () => {
    const v = compose(buildDraft(), buildOpts);
    v.artifact_hash = null;
    const res = validate(v);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/artifact_hash/);
  });
});

describe("topLevelFromRecorded — re-derivation", () => {
  it("re-derives PASS for a genuinely-earned build PASS", () => {
    const v = compose(buildDraft(), buildOpts);
    expect(v.verdict).toBe("PASS");
    expect(topLevelFromRecorded(v)).toBe("PASS");
  });

  it("re-derives unevaluated for a forged PASS with empty recorded components", () => {
    const forged = {
      stage: "build",
      verdict: "PASS",
      sha: SHA,
      artifact_hash: hashArtifact(ARTIFACT),
      judge_fingerprint: FP,
      dimensions: {},
      routes: [],
      scenarios: [],
      generated_at: NOW,
    };
    expect(topLevelFromRecorded(forged)).not.toBe("PASS");
  });

  it("re-derives unevaluated when the recorded manifest is a bare {verified:true} (unbound)", () => {
    const v = compose(buildDraft(), buildOpts);
    v.manifest = { verified: true }; // strip the binding a forger cannot fake
    expect(topLevelFromRecorded(v)).not.toBe("PASS");
  });
});

describe("compose carries evidence_redacted (review posture)", () => {
  it("keeps evidence_redacted: true from a build draft and omits it otherwise", () => {
    const remote = compose(buildDraft({ target_url: "https://pr-1.preview.example", evidence_redacted: true }), buildOpts);
    expect(remote.evidence_redacted).toBe(true);
    expect(remote.verdict).toBe("PASS");
    expect("evidence_redacted" in compose(buildDraft(), buildOpts)).toBe(false);
  });
});

describe("CLI rederive", () => {
  const scratch = mkdtempSync(join(tmpdir(), "acceptance-rederive-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const cli = (...a) => spawnSync(process.execPath, [join(import.meta.dirname, "../../skills/ko-acceptance-validator/scripts/verdict.mjs"), ...a], { encoding: "utf8" });

  it("AE7: a forged empty PASS prints recorded PASS, derived unevaluated, and its sha", () => {
    const file = join(scratch, "forged.json");
    writeFileSync(
      file,
      JSON.stringify({ stage: "build", verdict: "PASS", sha: SHA, artifact_hash: hashArtifact(ARTIFACT), judge_fingerprint: FP, dimensions: {}, routes: [], scenarios: [], generated_at: "x" }),
    );
    const r = cli("rederive", file);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ recorded: "PASS", derived: "unevaluated", sha: SHA });
  });

  it("an earned PASS re-derives to PASS", () => {
    const file = join(scratch, "earned.json");
    writeFileSync(file, JSON.stringify(compose(buildDraft(), buildOpts)));
    expect(JSON.parse(cli("rederive", file).stdout)).toEqual({ recorded: "PASS", derived: "PASS", sha: SHA });
  });

  it("an unreadable file exits non-zero with no stdout", () => {
    const r = cli("rederive", join(scratch, "nope.json"));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("compose precedence", () => {
  it("composes PASS when every dimension, route, scenario, and the manifest hold", () => {
    const v = compose(buildDraft(), buildOpts);
    expect(v.verdict).toBe("PASS");
    expect(v.artifact_hash).toBe(hashArtifact(ARTIFACT));
    expect(v.sha).toBe(SHA);
    expect(v.judge_fingerprint).toBe(FP);
    expect(v.target_url).toBe("http://localhost:5173/orders");
  });

  it("fails closed to unevaluated on a declared route marked Skip", () => {
    const v = compose(buildDraft({ routes: [{ route: "/orders", result: "Skip", reason: "requires credentials" }] }), buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/skip|credentials/i);
  });

  it("fails closed to unevaluated on a diff-mapped route marked Skip", () => {
    const routes = [
      { route: "/orders", result: "Pass", reason: "" },
      { route: "/payments", result: "Skip", reason: "diff-mapped, unreachable" }, // never declared in the artifact
    ];
    const v = compose(buildDraft({ routes }), buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/payments/);
  });

  it("fails closed to unevaluated when a declared @route is never exercised", () => {
    const v = compose(buildDraft({ routes: [] }), buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/\/orders/);
  });

  it("fails closed to unevaluated when a required build dimension has empty evidence", () => {
    const draft = buildDraft();
    draft.dimensions.legibility.evidence = [];
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/legibility/);
  });

  it("fails closed to unevaluated on a spec-stage REQUIRED not_applicable dimension (C1)", () => {
    const v = compose(
      specDraft({
        "workflow-fit": { status: "not_applicable", findings: [], evidence: [] },
        "intent-match": { status: "PASS", findings: [], evidence: [] },
        legibility: { status: "not_applicable", findings: [], evidence: [] },
        "convention-fit": { status: "not_applicable", findings: [], evidence: [] },
      }),
      specOpts,
    );
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/workflow-fit/);
  });

  it("fails closed to unevaluated on a build-stage not_applicable dimension", () => {
    const draft = buildDraft();
    draft.dimensions["convention-fit"].status = "not_applicable";
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/convention-fit/);
  });

  it("fails closed to unevaluated when the execution manifest is missing or unverified", () => {
    expect(compose(buildDraft(), { ...buildOpts, manifest: undefined }).verdict).toBe("unevaluated");
    expect(compose(buildDraft(), { ...buildOpts, manifest: { verified: false } }).verdict).toBe("unevaluated");
    expect(compose(buildDraft(), { ...buildOpts, manifest: { verified: false } }).reason).toMatch(/manifest/i);
  });

  it("fails closed to unevaluated on a route whose result is Fail (C2)", () => {
    const v = compose(buildDraft({ routes: [{ route: "/orders", result: "Fail", reason: "assertion failed" }] }), buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/\/orders failed/);
  });

  it("fails closed to unevaluated when a required dimension's evidence is an empty/whitespace string (A4a)", () => {
    for (const bogus of [[""], ["  "], ["ok.png", ""]]) {
      const draft = buildDraft();
      draft.dimensions.legibility.evidence = bogus;
      const v = compose(draft, buildOpts);
      expect(v.verdict).toBe("unevaluated");
      expect(v.reason).toMatch(/legibility has no evidence/);
    }
  });

  it("fails closed to unevaluated when a scenario names a route never exercised in routes[] (A4b)", () => {
    const draft = buildDraft();
    draft.scenarios.push({ id: "ghost", kind: "good", dimension: "workflow-fit", route: "/ghost", status: "held" });
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/\/ghost/);
  });

  it("fails closed to unevaluated when a required dimension is satisfied only by a ghost-route scenario (A4b)", () => {
    // workflow-fit's only scenario is on an unexercised route → the dimension is not satisfied.
    const draft = buildDraft();
    draft.scenarios = draft.scenarios.map((s) => (s.dimension === "workflow-fit" ? { ...s, route: "/ghost" } : s));
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/workflow-fit has no matching @dimension scenario/);
  });

  it("fails closed to unevaluated when the manifest is verified but bound to a different sha (A2)", () => {
    const v = compose(buildDraft(), { ...buildOpts, manifest: { ...MANIFEST, sha: "0000000othersha" } });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/manifest/i);
  });

  it("fails closed to unevaluated when the manifest routes do not cover routes[] (A2)", () => {
    // routes[] exercises /orders, but the manifest only vouches for /payments → not a superset.
    const v = compose(buildDraft(), { ...buildOpts, manifest: { ...MANIFEST, routes: [{ route: "/payments", result: "Pass" }] } });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/manifest/i);
  });

  it("fails closed to unevaluated when the manifest artifact_hash is from a different artifact (A2)", () => {
    const v = compose(buildDraft(), { ...buildOpts, manifest: { ...MANIFEST, artifact_hash: hashArtifact("different bytes") } });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/manifest/i);
  });

  it("keeps REJECT ahead of unevaluated (REJECT wins over a Skip route)", () => {
    const draft = buildDraft({ routes: [{ route: "/orders", result: "Skip", reason: "x" }] });
    draft.dimensions["workflow-fit"].status = "REJECT";
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("REJECT");
  });

  it("composes CONCERNS when nothing rejects or fails closed but a dimension has concerns", () => {
    const v = compose(
      specDraft({
        "workflow-fit": { status: "CONCERNS", findings: ["ambiguous path"], evidence: [] },
        "intent-match": { status: "PASS", findings: [], evidence: [] },
        legibility: { status: "not_applicable", findings: [], evidence: [] },
        "convention-fit": { status: "not_applicable", findings: [], evidence: [] },
      }),
      specOpts,
    );
    expect(v.verdict).toBe("CONCERNS");
  });

  it("composes spec-stage PASS with legibility/convention-fit not_applicable", () => {
    const v = compose(
      specDraft({
        "workflow-fit": { status: "PASS", findings: [], evidence: [] },
        "intent-match": { status: "PASS", findings: [], evidence: [] },
        legibility: { status: "not_applicable", findings: [], evidence: [] },
        "convention-fit": { status: "not_applicable", findings: [], evidence: [] },
      }),
      specOpts,
    );
    expect(v.verdict).toBe("PASS");
    expect(v.artifact_hash).toBe(hashArtifact(ARTIFACT));
  });

  it("is idempotent — same draft, artifact, and SHA under a frozen clock give byte-identical output", () => {
    const a = compose(buildDraft(), buildOpts);
    const b = compose(buildDraft(), buildOpts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("marks artifact_hash null only for an artifact-unavailable unevaluated", () => {
    const v = compose(specDraft({}), { sha: SHA, fingerprint: FP, reason: "insufficient-intent: no issue" });
    expect(v.verdict).toBe("unevaluated");
    expect(v.artifact_hash).toBeNull();
    expect(validate(v).ok).toBe(true);
  });
});

describe("persist", () => {
  const scratch = mkdtempSync(join(tmpdir(), "acceptance-verdict-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("writes <stage>-<sha7>-<hash7>-<fp7>.json under the given base dir", () => {
    const v = compose(buildDraft(), buildOpts);
    const file = persist(v, { baseDir: scratch });
    const sha7 = SHA.slice(0, 7);
    const hash7 = hashArtifact(ARTIFACT).slice(0, 7);
    const fp7 = createHash("sha256").update(FP).digest("hex").slice(0, 7);
    expect(file).toBe(join(scratch, `build-${sha7}-${hash7}-${fp7}.json`));
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).verdict).toBe("PASS");
  });

  it("re-keys the filename on a rubric change so a stale verdict is not overwritten (A3)", () => {
    const a = persist(compose(buildDraft(), buildOpts), { baseDir: scratch });
    // same sha + artifact, different judge fingerprint (rubric/persona change) → different file.
    const b = persist(compose(buildDraft(), { ...buildOpts, fingerprint: "model-x@ffffffffffff" }), { baseDir: scratch });
    expect(a).not.toBe(b);
    expect(fingerprintKey(FP)).not.toBe(fingerprintKey("model-x@ffffffffffff"));
  });
});

describe("the artifact must be valid Gherkin", () => {
  const WRAPPED = "Feature: F\n\n  @kind:good @dimension:workflow-fit @route:/orders\n  Scenario: S\n    Given a\n    When b\n    Then c\n      wrapped\n";

  it("composes unevaluated with the lint line and keeps the hash of the bytes that exist", () => {
    const v = compose(buildDraft(), { ...buildOpts, artifactText: WRAPPED });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/^malformed-artifact: 8: /);
    expect(v.artifact_hash).toBe(hashArtifact(WRAPPED));
    expect(validate(v).ok).toBe(true);
  });

  it("applies at the spec stage too", () => {
    const dims = { "workflow-fit": { status: "PASS" }, "intent-match": { status: "PASS" }, legibility: { status: "not_applicable" }, "convention-fit": { status: "not_applicable" } };
    const v = compose(specDraft(dims), { ...specOpts, artifactText: WRAPPED });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/malformed-artifact/);
  });

  it("a REJECT dimension still wins over a malformed artifact", () => {
    const draft = buildDraft();
    draft.dimensions.legibility.status = "REJECT";
    expect(compose(draft, { ...buildOpts, artifactText: WRAPPED }).verdict).toBe("REJECT");
  });
});

describe("the verdict's scenarios must match the artifact's", () => {
  it("a scenario dropped from the draft composes unevaluated, naming it", () => {
    const draft = buildDraft();
    draft.scenarios = draft.scenarios.filter((s) => s.id !== "g3");
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/scenario g3 missing/);
  });

  it("a scenario the artifact does not hold composes unevaluated, naming it", () => {
    const draft = buildDraft();
    draft.scenarios.push({ id: "extra", kind: "good", dimension: "legibility", route: "/orders", status: "held" });
    const v = compose(draft, buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/scenario extra is not in the artifact/);
  });

  it("the same scenario recorded twice composes unevaluated", () => {
    const draft = buildDraft();
    draft.scenarios.push({ ...draft.scenarios[0] });
    expect(compose(draft, buildOpts).reason).toMatch(/scenario g1 recorded more than once/);
  });

  const MULTI = "Feature: F\n\n" + scenarioText("@kind:good @dimension:workflow-fit @route:/orders @route:/orders/:id", "m") +
    "\n" + scenarioText("@kind:good @dimension:legibility @route:/orders", "l") +
    "\n" + scenarioText("@kind:good @dimension:intent-match @route:/orders", "i") +
    "\n" + scenarioText("@kind:good @dimension:convention-fit @route:/orders", "c");
  const multiRoutes = [{ route: "/orders", result: "Pass", reason: "" }, { route: "/orders/:id", result: "Pass", reason: "" }];
  const multiDraft = (route) =>
    buildDraft({
      routes: multiRoutes,
      scenarios: [
        { id: "m", kind: "good", dimension: "workflow-fit", route, status: "held" },
        { id: "l", kind: "good", dimension: "legibility", route: "/orders", status: "held" },
        { id: "i", kind: "good", dimension: "intent-match", route: "/orders", status: "held" },
        { id: "c", kind: "good", dimension: "convention-fit", route: "/orders", status: "held" },
      ],
    });
  const multiOpts = { artifactText: MULTI, sha: SHA, fingerprint: FP, manifest: { verified: true, sha: SHA, artifact_hash: hashArtifact(MULTI), routes: multiRoutes } };

  it("a multi-route scenario recorded on one declared route passes when both routes ran", () => {
    expect(compose(multiDraft("/orders/:id"), multiOpts).verdict).toBe("PASS");
  });

  it("a multi-route scenario with one declared route unexercised fails closed, naming it", () => {
    const draft = multiDraft("/orders/:id");
    draft.routes = [multiRoutes[1]];
    const v = compose(draft, multiOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/declared route \/orders not exercised/);
  });

  it("a row on a route its scenario did not declare fails closed", () => {
    const draft = multiDraft("/payments");
    draft.routes = [...multiRoutes, { route: "/payments", result: "Pass", reason: "" }];
    const v = compose(draft, { ...multiOpts, manifest: { ...multiOpts.manifest, routes: draft.routes } });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/scenario m recorded on undeclared route \/payments/);
  });

  it("a route declared only through a feature-level tag counts as declared", () => {
    const text = "@route:/orders\nFeature: F\n\n" + scenarioText("@kind:good @dimension:workflow-fit", "only");
    const v = compose(buildDraft({ routes: [] }), { artifactText: text, sha: SHA, fingerprint: FP });
    expect(v.reason).toMatch(/declared route \/orders not exercised/);
  });

  it("a route written in a comment is never declared", () => {
    const text = ARTIFACT + "\n# @route:/ghost\n";
    const v = compose(buildDraft(), { ...buildOpts, artifactText: text, manifest: { ...MANIFEST, artifact_hash: hashArtifact(text) } });
    expect(v.verdict).toBe("PASS");
  });
});

describe("a reason on the draft", () => {
  it("composes unevaluated with that reason first, even with a valid artifact", () => {
    const v = compose(buildDraft({ reason: "browser-unavailable" }), buildOpts);
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/^browser-unavailable/);
    expect(v.artifact_hash).toBe(hashArtifact(ARTIFACT));
    expect(validate(v).ok).toBe(true);
  });

  it("re-derives as unevaluated, so a recorded reason is not promoted to PASS", () => {
    const v = compose(buildDraft({ reason: "target-stale" }), buildOpts);
    expect(topLevelFromRecorded(v)).toBe("unevaluated");
  });

  it("loses to a REJECT dimension", () => {
    const draft = buildDraft({ reason: "browser-unavailable" });
    draft.dimensions.legibility.status = "REJECT";
    expect(compose(draft, buildOpts).verdict).toBe("REJECT");
  });

  it("missing-judge with no artifact persists with a null hash", () => {
    const scratch = mkdtempSync(join(tmpdir(), "acceptance-judge-"));
    const v = compose(specDraft({}), { sha: SHA, fingerprint: FP, reason: "missing-judge" });
    expect(v.verdict).toBe("unevaluated");
    expect(v.reason).toMatch(/^missing-judge/);
    expect(v.artifact_hash).toBeNull();
    expect(validate(v).ok).toBe(true);
    expect(existsSync(persist(v, { baseDir: scratch }))).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });
});

describe("fingerprint CLI", () => {
  const scratch = mkdtempSync(join(tmpdir(), "acceptance-fp-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const cli = (...a) => spawnSync(process.execPath, [join(import.meta.dirname, "../../skills/ko-acceptance-validator/scripts/verdict.mjs"), ...a], { encoding: "utf8" });

  it("changes when one byte of the judge file changes", () => {
    const file = join(scratch, "judge.md");
    writeFileSync(file, "judge A");
    const first = cli("fingerprint", file, "model-x").stdout;
    writeFileSync(file, "judge B");
    expect(cli("fingerprint", file, "model-x").stdout).not.toBe(first);
  });

  it("hashes a missing judge file as empty bytes and exits 0", () => {
    const r = cli("fingerprint", join(scratch, "missing.md"), "model-x");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(judgeFingerprint("", "model-x"));
  });
});

describe("persist ignore file", () => {
  it("writes .gitignore holding * beside the verdict", () => {
    const scratch = mkdtempSync(join(tmpdir(), "acceptance-ignore-"));
    persist(compose(buildDraft(), buildOpts), { baseDir: scratch });
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n");
    rmSync(scratch, { recursive: true, force: true });
  });
});
