import { describe, it, expect } from "vitest";
import { compose, hashArtifact } from "../../skills/ko-acceptance-validator/scripts/verdict.mjs";
import { gate } from "../../skills/ko-acceptance-validator/scripts/gate.mjs";

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
      { id: "g1", dimension: "workflow-fit", route: "/orders", status: "held" },
      { id: "g2", dimension: "legibility", route: "/orders", status: "held" },
      { id: "g3", dimension: "intent-match", route: "/orders", status: "held" },
      { id: "b1", dimension: "convention-fit", route: "/orders", status: "held" },
    ],
    ...overrides,
  };
}
// A manifest bound to this run (verified + same sha/hash + route table ⊇ routes[]) so the build
// actually earns PASS (A2).
const MANIFEST = { verified: true, sha: SHA, artifact_hash: hashArtifact(ARTIFACT), routes: [{ route: "/orders", result: "Pass" }] };
const buildPass = () => compose(buildDraft(), { artifactText: ARTIFACT, sha: SHA, fingerprint: FP, manifest: MANIFEST });

describe("gate — advisory consumer", () => {
  it("would-pass for a valid stage:build PASS with target_url and matching SHA + hash", () => {
    const v = buildPass();
    expect(v.verdict).toBe("PASS"); // guard the fixture
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toBe("would-pass");
  });

  it("would-block: wrong-stage for a spec-stage PASS even with matching SHA and hash", () => {
    const spec = compose(
      {
        stage: "spec",
        artifact_path: "docs/plans/x.feature",
        dimensions: {
          "workflow-fit": { status: "PASS", findings: [], evidence: [] },
          "intent-match": { status: "PASS", findings: [], evidence: [] },
          legibility: { status: "not_applicable", findings: [], evidence: [] },
          "convention-fit": { status: "not_applicable", findings: [], evidence: [] },
        },
        routes: [],
        scenarios: [],
      },
      { artifactText: ARTIFACT, sha: SHA, fingerprint: FP },
    );
    expect(spec.verdict).toBe("PASS"); // a genuine spec PASS
    expect(gate(JSON.stringify(spec), ARTIFACT, SHA)).toBe("would-block: wrong-stage");
  });

  it("would-block: unevaluated:<reason> for an unevaluated verdict", () => {
    const v = compose(buildDraft(), { artifactText: ARTIFACT, sha: SHA, fingerprint: FP, manifest: undefined });
    expect(v.verdict).toBe("unevaluated");
    const out = gate(JSON.stringify(v), ARTIFACT, SHA);
    expect(out).toMatch(/^would-block: unevaluated: /);
    expect(out).toContain(v.reason);
  });

  it("would-block: unparseable for markdown prose passed instead of JSON, without throwing", () => {
    expect(() => gate("# not json at all\n- bullet", ARTIFACT, SHA)).not.toThrow();
    expect(gate("# not json at all\n- bullet", ARTIFACT, SHA)).toBe("would-block: unparseable");
  });

  it("would-block: artifact-drift when the .feature changed since the verdict", () => {
    const v = buildPass();
    const drifted = ARTIFACT + "\n# an added line changes the hash";
    expect(hashArtifact(drifted)).not.toBe(v.artifact_hash);
    expect(gate(JSON.stringify(v), drifted, SHA)).toBe("would-block: artifact-drift");
  });

  it("would-block: sha-mismatch when the SHA differs", () => {
    const v = buildPass();
    expect(gate(JSON.stringify(v), ARTIFACT, "0000000deadbeef")).toBe("would-block: sha-mismatch");
  });

  it("would-block: not-earned for a forged PASS whose recorded components are empty (A1)", () => {
    // A schema-valid PASS with matching public sha + hash but empty dimensions/routes/scenarios.
    const forged = {
      schema: "acceptance-verdict/v1",
      stage: "build",
      verdict: "PASS",
      sha: SHA,
      artifact_hash: hashArtifact(ARTIFACT),
      artifact_path: "docs/plans/x.feature",
      target_url: "http://localhost:5173/orders",
      judge_fingerprint: FP,
      dimensions: {},
      routes: [],
      scenarios: [],
      generated_at: "2026-09-16T12:00:00.000Z",
    };
    expect(gate(JSON.stringify(forged), ARTIFACT, SHA)).toBe("would-block: not-earned");
  });

  it("would-block: not-earned when a build PASS carries an unbound {verified:true} manifest (A1/A2)", () => {
    const v = buildPass();
    v.manifest = { verified: true }; // recorded manifest stripped of its sha/hash/routes binding
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toBe("would-block: not-earned");
  });

  it("would-block: invalid for a schema-invalid verdict (missing sha)", () => {
    const v = buildPass();
    delete v.sha;
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toMatch(/^would-block: invalid: /);
  });

  it("would-block: reject for a REJECT build verdict", () => {
    const draft = buildDraft();
    draft.dimensions["workflow-fit"].status = "REJECT";
    const v = compose(draft, { artifactText: ARTIFACT, sha: SHA, fingerprint: FP, manifest: MANIFEST });
    expect(v.verdict).toBe("REJECT");
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toBe("would-block: reject");
  });

  it("would-block: concerns for a CONCERNS build verdict", () => {
    const draft = buildDraft();
    draft.dimensions["convention-fit"].status = "CONCERNS";
    const v = compose(draft, { artifactText: ARTIFACT, sha: SHA, fingerprint: FP, manifest: MANIFEST });
    expect(v.verdict).toBe("CONCERNS");
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toBe("would-block: concerns");
  });

  it("would-block: missing-target-url for a build PASS with no target_url", () => {
    const v = buildPass();
    delete v.target_url;
    expect(gate(JSON.stringify(v), ARTIFACT, SHA)).toBe("would-block: missing-target-url");
  });

  it("would-block: stale-fingerprint when the verdict's fingerprint differs from the expected one (A3)", () => {
    const v = buildPass();
    expect(gate(JSON.stringify(v), ARTIFACT, SHA, "model-x@ffffffffffff")).toBe("would-block: stale-fingerprint");
  });

  it("would-pass when the expected fingerprint matches the verdict's (A3)", () => {
    const v = buildPass();
    expect(gate(JSON.stringify(v), ARTIFACT, SHA, FP)).toBe("would-pass");
  });
});
