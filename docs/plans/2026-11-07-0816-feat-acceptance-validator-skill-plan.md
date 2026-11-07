---
title: Acceptance validator skill - Plan
type: feat
date: 2026-11-07
topic: acceptance-validator-skill
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Acceptance validator skill - Plan

## Goal Capsule

- **Objective:** Any full-stack repo that installs `ko-acceptance-validator` gets the same two-stage judgment of a change — the plan before code, the running app after deploy — from one Gherkin `.feature` file, in the voice of a judge that repo defines for itself, and its coding agents read those same scenarios when they write tests. Nothing in the skill names any project.
- **Means:** port the source skill's spec and build stages, verdict shim, gate and evidence step into `skills/ko-acceptance-validator/`, put a shipped zero-dependency Gherkin parser under all of them (KTD1), move every project fact into a per-repo judge file (KTD7), and guard the result with repo-level tests (KTD11).
- **Authority:** this plan, then the user's instructions in the planning session. The behavioral reference is the source skill and its scripts in the source project: machine-local, read only, never copied verbatim, and not named here.
- **Execution profile:** one dashed `feat-` branch of this repo carrying the plan, skill, tests and README, committed locally with no PR (KD7). Scripts first and test-first, then prose references, then guards and README. No push unless asked.
- **Stop conditions:**
  - The official Gherkin parser rejects a file the shipped lint accepts, and tightening the lint cannot close the gap.
  - A rule cannot be expressed without naming the source project.
- **Tail ownership:** moving the source project onto this skill, and repairing its six unparseable `.feature` files, is operator-run follow-up (see Deferred).

---

## Product Contract

### Summary

Add `skills/ko-acceptance-validator/`. Its `spec` stage reads a plan and any request document, writes acceptance scenarios as a parser-valid Gherkin `.feature` next to the plan, and judges the plan on intent-match and workflow-fit. Its `build` stage walks the running app against the same file, page routes through a browser and API routes over HTTP, judges all four dimensions, and composes a fail-closed verdict that an advisory gate can read and an evidence step can post to the PR. A shipped `gherkin.mjs` lints the file and lists its scenarios as JSON, so coding agents can read them when writing tests. Who judges, what the app's words are, how to run it and how to sign in all live in one judge file in the consumer repo. Until that file exists the verdict is `unevaluated`.

### Problem Frame

The judgment that asks "is this the thing its real user needed" exists once, inside one private project, tied to that project's judge, cloud, login flow and test tools. Its `.feature` files are read with three regexes over the whole file, so a tag inside a comment counts and a malformed file passes silently. Running the official parser over that project's 139 files found 6 that fail to parse, and nothing in the current flow notices. Coding agents in that project have no defined way to read the scenarios, so the tests they write do not line up with what the judge checks.

### Key Decisions

- KD1. **A project supplies its own judge in a file; a missing judge yields `unevaluated`, never a guess.** First interactive run drafts the file from repo docs and asks for confirmation. (session-settled: user-approved — chosen over a hardcoded default judge: a default would guess at a job it cannot know.) Governs R9, R10, R11.
- KD2. **Tags are identical for pages and APIs; `@route:` may name an API path, and a no-UI change is judged by calling the endpoint.** (session-settled: user-approved — chosen over "no UI means unevaluated": backend-only changes would never be judged.) Governs R7, R16.
- KD3. **Coding agents consume scenarios through a short guide and a listing command; the skill generates no test code and runs no BDD runtime.** (session-settled: user-approved — chosen over a test-generating stage: generated tests would drift from the project's own runner and style.) Governs R25, R26.
- KD4. **The build stage uses whatever browser tool the agent has; the judge file says how to sign in.** The source's sign-in script and its required browser-test skill are dropped. (session-settled: user-approved — chosen over bundling a sign-in script: that script encodes one login vendor.) Governs R14, R15.
- KD5. **Remote-target safety stays: blurred screenshots and writes limited to one test record.** (session-settled: user-approved — chosen over treating a deployed preview like localhost: a preview can show real data.) Governs R18, R23.
- KD6. **Left out: the two agent-specific reminder hooks and the calibration replay. The advisory gate stays.** (session-settled: user-approved — chosen over porting them: hooks bind to one agent and installs copy only the folder, and replay has no value without a labeled corpus.) Governs R24.
- KD7. **Deliverable is the plan, the skill, its tests and a README section on a branch; no push or PR unless asked.** (session-settled: user-approved — chosen over opening the PR in the same run.) Governs R27.
- KD8. **Gherkin is at the core: the `.feature` is real, parser-valid Gherkin and the skill enforces it.** (session-settled: user-directed — chosen over the source's regex-only reading: the 6-of-139 gap and the comment-tag hole.) Governs R4, R5, R6, R8.

### Requirements

**Packaging and sanitization**

- R1. `npx skills add kevinold/skills -s ko-acceptance-validator` installs one folder with `SKILL.md`, `references/` and `scripts/`, and every script runs on node 22 with no npm install in the consumer repo.
- R2. The skill names no project, person, vendor, cloud, login provider, test runner, planning skill or local path. A repo-level test enforces this on the skill folder, this plan and the README.
- R3. The skill names no other skill or plugin as required. It says "your planning step" and "your plan file", and `--issue` is optional.

**Gherkin artifact**

- R4. The shared artifact is one `.feature` file that the official Gherkin parser accepts. The shipped `gherkin.mjs lint` rejects, with a line number, every file the official parser rejects, and may reject more.
- R5. Lint enforces the tag contract on every scenario: exactly one `@kind` of `good|bad`, exactly one `@dimension` of the four, at least one `@route` that is a path-only reference (KTD3), a unique `slug(name)` per file, and at least one `Then`. A missing `Given` or `When` is a warning. `Scenario Outline` and `Examples` are lint errors with a line number; each case is written as its own `Scenario` (KTD2).
- R6. Tags follow real Gherkin inheritance from `Feature` and `Rule`; anything inside a comment never counts.
- R7. A `@route:` value is a URL path for a page or an API endpoint, and the build stage drives each by kind (KD2).
- R8. The default artifact path is `<plan-dir>/<plan-basename>.feature`; `--feature <path>` overrides it; review posture, which is any run given `--pr <n>`, derives into `.tmp/acceptance/review-<PR>.feature` and never commits it.

**Judge**

- R9. The judge is `docs/acceptance/judge.md` by default, `--judge <path>` overrides it, and the judge fingerprint is the model id folded with a hash of that file's bytes. In review posture the judge is read from the PR's base branch, never the PR's own copy, because its sign-in and remote-safety sections direct an agent holding secrets.
- R10. With no judge file, both stages compose `unevaluated` with `reason: missing-judge` and write no `.feature`. In an interactive run the spec stage first drafts the judge from the repo's README, architecture, design and glossary docs, then asks the user to confirm; committing it is the user's act.
- R11. The judge template covers: who judges and in what voice; where the job, entry point and success path are named; where UI and API conventions live; at least one anchor case per dimension, labeled when hypothetical; how to run the app with its local URL, API base prefixes and where routes are defined; sign-in by environment variable names only; and remote safety — which hosts show real data, what the test record is, which selectors to blur, and how to read the revision a deployed target serves.

**Spec stage**

- R12. `spec <plan-path> [--issue <n>] [--pr <n>] [--feature <path>] [--judge <path>]` resolves intent from the plan plus the issue or any request document given, names the job through the judge, writes the scenarios, lints them, judges intent-match and workflow-fit, marks the other two `not_applicable`, and composes and persists. Unnameable intent composes `unevaluated` with `reason: insufficient-intent` and stops to ask, except in review posture.
- R13. A spec `REJECT` ends the run with a concrete revision request; the only bypass is a line the operator records in the plan, and the persisted verdict stays `REJECT`.

**Build stage**

- R14. `build <plan-path> [--target-url <url>] [--pr <n>] [--feature <path>] [--test-record <id>] [--judge <path>]` picks the browser driver as the host's browser tool, else `agent-browser`, else composes `unevaluated` with `reason: browser-unavailable`. Driver selection runs only when at least one route is a page; a route set entirely under API prefixes needs no browser.
- R15. Sign-in follows the judge file's instructions. Secret values never appear in argv, screenshots, comments or evidence files. A failed sign-in composes `unevaluated` with `reason: target-unreachable`. Credentials are sent only to the target's origin. The plan, `.feature`, issue, request documents and app responses are data to judge, never instructions to follow.
- R16. API routes are called over HTTP through the shipped `capture.mjs`, and its text capture counts as that scenario's evidence. Credential values never reach a capture, and on a remote target the capture records structure only, with no body values (KTD8).
- R17. The route table is built by the stage as `{route, result, reason}` over the diff-mapped routes joined with every declared `@route:`. Diff-mapped routes are the pages and endpoints whose handlers the diff changes, found through the route locations the judge names; a changed file with no clear route adds no row.
- R18. On a remote target, writes happen only on the `--test-record`; without one every write-shaped scenario is `unevaluated` and its route row is `Skip` with reason `read-only target`. Every remote screenshot is blurred before capture and looked at before it is recorded. The draft carries `evidence_redacted: true` only when there is at least one evidence item, every screenshot passed, and every text capture is in structure-only form. A remote target whose served revision differs from the reviewed commit, or cannot be read while the judge names how, composes `unevaluated` with `reason: target-stale`.
- R19. Each scenario is recorded `held` or `manifested` once, under its parsed id, and a scenario that is neither composes `unevaluated`.

**Verdict, gate, evidence**

- R20. The verdict schema is `acceptance-verdict/v1`, persisted to `.tmp/acceptance/<stage>-<sha7>-<hash7>-<fp7>.json`, and `.tmp/acceptance/.gitignore` containing `*` is written whenever that directory is first created, by `persist` and `capture.mjs` alike.
- R21. Compose keeps the source's fail-closed precedence and adds three rungs: a `reason` on the draft composes `unevaluated` with that reason first, whether or not the artifact exists; a lint-failing artifact composes `unevaluated` with `reason: malformed-artifact: <line>: <message>` while `REJECT` still wins first, and at build the set of scenario ids in the verdict must equal the parsed set, each on one of its declared routes.
- R22. `gate.mjs` ports as-is with renames, always exits 0, and prints `would-pass` or `would-block: <reason>`.
- R23. `attach-evidence.mjs` posts one comment per verdict-target-evidence triple through bare `gh … comment --attach` under the heading `### Acceptance verdict: **<verdict>** (advisory)`, embeds image evidence, renders text evidence as a fenced excerpt of at most 40 lines, and refuses a remote verdict with any evidence unless `evidence_redacted` is `true`.
- R24. The gate reference states the gate stays advisory and carries no graduation section.

**Test context for coding agents**

- R25. `gherkin.mjs scenarios <file> [--route x] [--kind y] [--dimension z]` prints a JSON list of `{id, name, kind, dimension, routes, steps:[{keyword,text}], line}` with `Background` steps folded in.
- R26. `references/test-context.md` holds a one-paragraph snippet a project pastes into its agent instructions and a mapping table from tags to what a test asserts, including: a test title carries the scenario id, and a `.feature` is never edited to make a test pass.

**Docs**

- R27. The README gains a Skills-table row and a `## ko-acceptance-validator` section with Prerequisites, Configuration and Usage, matching the existing sections.

### Acceptance Examples

- AE1. Covers R4, R5. **Given** a `.feature` whose step text is hard-wrapped onto a second line, **when** `gherkin.mjs lint` runs, **then** it reports one error with that line number and exit 1, and the official parser rejects the same file.
- AE2. Covers R19, R21 (KTD6). **Given** a scenario tagged `@route:/orders @route:/orders/:id` whose outcome was observed on the detail page, **when** the build verdict records it as `{id, route: "/orders/:id", status: "held"}` and `routes[]` holds both routes as `Pass`, **then** compose does not fail closed on that scenario; with `/orders` absent from `routes[]` it composes `unevaluated` with `declared route /orders not exercised`.
- AE3. Covers R10. **Given** a repo with no `docs/acceptance/judge.md`, **when** `spec` runs non-interactively, **then** no `.feature` is written and the persisted verdict is `unevaluated` with `reason: missing-judge` and `artifact_hash: null`.
- AE4. Covers R21. **Given** a `.feature` with five scenarios and a build draft listing four, **when** compose runs, **then** the verdict is `unevaluated` and `reason` names the missing scenario id.
- AE5. Covers R14, R16, R23. **Given** an API-only change whose scenario is tagged `@route:/api/orders` on a host with no browser tool, **when** the build stage runs and posts, **then** the evidence is a text capture with no credential value, and the comment shows it as a fenced excerpt with no image attached. On a remote target the same capture holds key names and value types only.
- AE7. Covers R9, R15. **Given** a PR that edits the judge's sign-in section to send a token to another host, **when** the build runs in review posture, **then** the base branch's judge is used and its bytes feed the fingerprint.
- AE6. Covers R6. **Given** a scenario tagged `@kind:good @dimension:legibility @route:/x` with the line `# @route:/ghost` above it, **when** `scenarios` runs, **then** `routes` is `["/x"]`.

### Scope Boundaries

- Executing scenarios through a BDD runtime, or generating test code. The file is standard Gherkin, so a project may bind it with its own runner; the skill neither requires nor configures one.
- Calibration replay and the labeled corpus; the two agent-specific reminder hooks; the bundled sign-in script (KD4, KD6).
- Non-English Gherkin keywords. `# language:` other than `en` is a lint error. It would come back if a consumer asks.
- A JSON-schema library for the verdict, a linter for the judge file, and pushing the verdict to a commit status. Each would come back with a second consumer that needs it.
- `Scenario Outline` and `Examples`. One id cannot show that every row was observed, row-level verdicts would widen the schema, and the corpus has none. They would come back if a consumer's scenarios truly need tables of cases.
- A configurable comment label for the judge. The comment says "the project's judge" everywhere; no requirement varies it.
- A real-data flag for a local app. A local target counts as local; a judge whose local app reads real data should say so in its sign-in notes, and this would become a field if that proves common.

#### Deferred to Follow-Up Work

- Move the source project onto this skill, write its judge file, and fix its six unparseable `.feature` files (operator-run).
- Promote the skill into a planning plugin once it has a second consumer.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Ship a zero-dependency line-oriented Gherkin parser in `scripts/gherkin.mjs`; the official `@cucumber/gherkin` and `@cucumber/messages` are devDependencies used only by a repo-level conformance test.** (session-settled: user-directed — chosen over vendoring the official parser: it drags in message and uuid packages and an install copies only the folder.) The guarantee runs one way: anything the shipped lint accepts, the official parser accepts. Governs R1, R4.
- KTD2. **Parser subset:** English keywords only; `Feature`, `Rule`, `Background`, `Scenario`/`Example`; steps `Given|When|Then|And|But|*`; tag lines, comments, doc strings, data tables, and free description text between a header and its first step. Exactly one `Feature`. A non-keyword line after a block's steps have begun is an error at that line, which is the official parser's behavior and the cause of 4 of the 6 corpus failures. These are errors too, because the official parser rejects them: inconsistent table cell counts, an unterminated doc string, a second `Background`, a `Background` after a `Scenario`, a tag above a `Background`, and a tag containing whitespace. Effective tags are feature plus rule plus scenario tags (R6).
- KTD3. **Lint contract and scenario id.** Syntax errors first, then R5 per scenario over effective tags. A route value must match `^/(?!/)[A-Za-z0-9._~:/?=&%#-]*$`, which rejects scheme-relative values and shell metacharacters and still accepts `/orders/:id` and `/admin#team`. `id = slug(name)`: lowercase, runs of non-alphanumerics to `-`, trimmed. Missing `Given` or `When` is a warning because 2 of 911 corpus scenarios lack a `When` and it is convention, not syntax. The prose-voice rule stays with the judge, not the lint.
- KTD4. **CLI seam:** `gherkin.mjs lint <file>` prints `{ok, errors:[{line,message}], warnings:[{line,message}]}` and exits 1 on errors; `gherkin.mjs scenarios <file> [filters]` prints the R25 list. Both read the file once and share one `parse()` export that `verdict.mjs` imports.
- KTD5. **`verdict.mjs` ports behavior as-is with these deltas:** schema token and persist dir (R20); `declaredTags` is replaced by `parse()` so declared routes come from effective tags; compose gains the three R21 rungs; `persist` writes the `.gitignore`. The `malformed-artifact` reason is not an artifact-unavailable code, so `artifact_hash` is the hash of the bytes that exist.
- KTD6. **Multi-route scenarios: `scenarios[].route` stays a single string and names the route the outcome was observed on; it must be one of that scenario's declared routes.** One row per scenario id. This is the smallest change: zero schema change, and the existing `declared route … not exercised` rung already forces every other declared route into `routes[]`. Rejected: one row per route, which duplicates ids and asks the judge to split one outcome N ways; and `routes: []` on the row, which ripples through `validate`, `deriveTopLevel`, `topLevelFromRecorded`, the gate and the comment renderer. Instantiates KD2. Governs R19, R21.
- KTD7. **Judge file replaces the source's fixed judge reference.** `fingerprint <judge-file> <modelId>` hashes the judge bytes, so a judge edit re-keys persisted verdicts the same way a rubric edit did. A missing judge file hashes as empty bytes and exits 0, so the `missing-judge` verdict can still persist. `missing-judge` is a plain unevaluated reason, valid with `artifact_hash` null at spec and non-null at build. Instantiates KD1. Governs R9, R10.
- KTD8. **Route kind comes from the judge file.** The judge's "running the app" section lists API base prefixes; a `@route:` under one is driven over HTTP, anything else is a page. A scenario on an API route names its HTTP method and expected status in its steps, an exception to the prose-voice rule because its user is an API caller; a scenario naming no method gets a `Skip` row with reason `no method named`. Instantiates KD2 and KD4. Governs R14, R16.
- KTD13. **`scripts/capture.mjs` makes the HTTP call, so the secret rules are code, not agent care.** It takes `--url`, `--method`, `--target`, `--scenario-id`, `--header-env Name=ENV_VAR` and `--secret-env ENV_VAR`, so credential values never appear in argv. It refuses a URL outside the target's origin and does not follow redirects off that origin. Before writing `.tmp/acceptance/evidence/<sha7>/<scenario-id>.txt` it replaces any header whose name matches `auth|cookie|token|key|secret`, and every occurrence of a named env var's value, with `[scrubbed]`. On a non-loopback target it writes method, path, status, header names and the JSON key structure with each scalar replaced by its type, and marks a non-JSON body as omitted. The judging agent still reads the live response on stdout. Governs R15, R16, R18.
- KTD9. **`attach-evidence.mjs` deltas:** bare `gh`; the R23 heading; the comment's first line says "the project's judge"; `selectEvidence` splits by extension so images attach and text files render inline; the remote-redaction refusal counts text files too. The `posted-<sha7>.json` marker stays for idempotency even without the hook. Governs R23.
- KTD10. **`gate.mjs` ports verbatim with renames.** Governs R22.
- KTD11. **Repo guards live in `test/acceptance-validator.test.mjs` and do not ship.** The hashed sweep moves from `test/meeting-prfaq.test.mjs` into `test/private-sweep.mjs` with that test's behavior unchanged; this skill's sweep adds hashes for the source judge word, org, vendors and test runner. All tests and fixtures live under `test/acceptance-validator/`, so an install carries no test file a consumer's runner could pick up. Also: every shipped `.mjs` imports only `./` siblings or `node:` specifiers; every relative link resolves inside the skill; no skill file holds an absolute local path; and a conformance test runs both parsers over the fixtures. Governs R1, R2.
- KTD12. **Fixtures are synthetic, in a bookings-and-orders domain,** under `test/acceptance-validator/fixtures/`. `valid/` includes a `Rule`, a `Background`, a multi-route scenario, a colon-valued route like `/orders/:id`, and a feature-level tag. `invalid-syntax/` holds what both parsers reject: hard-wrapped step, a `So I can…` line as a step, no `Feature:` line, and each structural error in KTD2. `invalid-contract/` holds what the official parser accepts and the shipped lint rejects: one file per R5 rule, including `@route://host/x`, `@route:/x$(y)` and a `Scenario Outline`.

### High-Level Technical Design

Data flow around the `.feature`:

```mermaid
flowchart TB
  P[Plan + request doc] --> S[spec stage]
  J[docs/acceptance/judge.md] --> S
  S --> F[plan-basename.feature]
  F --> L[gherkin.mjs lint]
  L -->|errors| U1[verdict unevaluated: malformed-artifact]
  L -->|ok| V1[verdict.mjs compose stage spec]
  F --> SC[gherkin.mjs scenarios JSON]
  SC --> T[coding agent writes tests, titles carry scenario id]
  F --> B[build stage: browser for pages, HTTP for API prefixes]
  J --> B
  B --> E[evidence: png and txt under .tmp/acceptance/evidence]
  B --> V2[verdict.mjs compose stage build]
  F --> V2
  V2 --> G[gate.mjs: would-pass or would-block, exit 0]
  V2 --> A[attach-evidence.mjs: gh comment --attach]
  E --> A
```

Directional grammar sketch of the parser subset and the tag contract:

```text
file      := [ "# language: en" ] tagline* "Feature:" name desc? background? ( scenario | rule )*
rule      := tagline* "Rule:" name desc? background? scenario*
background:= "Background:" name? step*
scenario  := tagline* ( "Scenario:" | "Example:" ) name desc? step*
step      := ( "Given" | "When" | "Then" | "And" | "But" | "*" ) text ( docstring | table )?
tagline   := ( "@" token )+          -- a "#" line is a comment, never a tagline

effective(s) = tags(feature) + tags(rule) + tags(s)
lint(s):  count(@kind:)      == 1  and value in {good, bad}                     -- error
          count(@dimension:) == 1  and value in {workflow-fit, legibility,
                                                 intent-match, convention-fit}  -- error
          count(@route:)     >= 1  and every value is a path-only reference     -- error
          slug(name) unique in file                                             -- error
          steps(background) + steps(s) has a Then                               -- error
          … has a Given and a When                                              -- warning
```

### Output Structure

```text
skills/
  ko-acceptance-validator/
    SKILL.md
    references/
      gherkin-format.md
      dimensions.md
      judge-template.md
      test-context.md
      build-stage.md
      verdict-schema.md
      gate-consumer.md
    scripts/
      gherkin.mjs
      verdict.mjs
      capture.mjs
      gate.mjs
      attach-evidence.mjs
test/
  private-sweep.mjs
  acceptance-validator/
    guards.test.mjs
    gherkin.test.mjs
    verdict.test.mjs
    capture.test.mjs
    gate.test.mjs
    attach-evidence.test.mjs
    fixtures/
      valid/*.feature
      invalid-syntax/*.feature
      invalid-contract/*.feature
  meeting-prfaq.test.mjs        (imports the extracted helper)
docs/plans/2026-11-07-0816-feat-acceptance-validator-skill-plan.md
README.md
package.json                    (two devDependencies, exact pins)
```

### Assumptions

- A `gh` with `comment --attach` is on the consumer's PATH.
- The official parser at `@cucumber/gherkin` 42.x keeps rejecting the three corpus failure classes; the conformance test pins the behavior.

---

## Implementation Units

### U1. Gherkin parser, lint and scenarios CLI

- **Goal:** `gherkin.mjs` parses the KTD2 subset, lints per KTD3, and lists scenarios per R25.
- **Requirements:** R4, R5, R6, R25
- **Dependencies:** none
- **Files:** `skills/ko-acceptance-validator/scripts/gherkin.mjs`, `test/acceptance-validator/gherkin.test.mjs`, `test/acceptance-validator/fixtures/valid/*.feature`, `test/acceptance-validator/fixtures/invalid-syntax/*.feature`, `test/acceptance-validator/fixtures/invalid-contract/*.feature`
- **Approach:** one pass over lines tracking the current block; export `parse(text)` returning `{feature, scenarios, errors}`, `lint(text)`, `listScenarios(text, filters)`, plus the KTD4 CLI. Write the fixtures first (KTD12), then the tests, then the parser.
- **Patterns to follow:** the CLI `main` and `import.meta.url` guard shape of the source `verdict.mjs`; vitest imports as in `skills/ko-multi-worker-pm/scripts/*.test.mjs`.
- **Execution note:** test-first; the fixture set is the spec.
- **Test scenarios:**
  - A valid fixture with `Rule`, `Background` and a feature-level tag lints `ok: true` and lists effective tags with the feature tag on every scenario.
  - A hard-wrapped step line yields exactly one error at that line number.
  - A file with no `Feature:` line yields an error at line 1.
  - A `# @route:/ghost` comment above a scenario does not appear in `routes`.
  - Two scenarios with the same name yield one error naming the second one's line.
  - A scenario with `Then` but no `When` yields `ok: true` and one warning.
  - `scenarios --kind bad --route /orders` returns only matching entries, with `Background` steps first.
  - `# language: fr` yields one error at that line.
  - A `Scenario Outline` yields one error at that line.
  - `@route://host/x` and `@route:/x$(y)` each yield one error; `@route:/orders/:id` and `@route:/admin#team` yield none.
- **Verification:** `npm test` green for the file; `node scripts/gherkin.mjs lint` exits 1 on every invalid fixture and 0 on every valid one.

### U2. Verdict shim port

- **Goal:** `verdict.mjs` composes, validates, re-derives and persists under the new schema with the parser underneath.
- **Requirements:** R9, R10, R19, R20, R21
- **Dependencies:** U1
- **Files:** `skills/ko-acceptance-validator/scripts/verdict.mjs`, `test/acceptance-validator/verdict.test.mjs`
- **Approach:** port the source module, then apply KTD5, KTD6 and KTD7. `compose` lints the artifact text first; errors become the `malformed-artifact` reason. At build, compare the verdict's scenario id set to the parsed set and check each row's `route` against that scenario's declared routes in the same loop.
- **Patterns to follow:** the source `verdict.test.mjs` case list, ported with neutral fixtures; `test/setup.mjs` frozen clock for the idempotency case.
- **Test scenarios:**
  - Same draft, artifact and sha give byte-identical output under the frozen clock.
  - A lint-failing artifact composes `unevaluated` with a `malformed-artifact:` reason and a non-null `artifact_hash`.
  - A `REJECT` dimension wins over a lint-failing artifact.
  - A build draft missing one parsed scenario id composes `unevaluated` naming it.
  - A build draft with an id the artifact lacks composes `unevaluated` naming it.
  - A multi-route scenario recorded on one of its declared routes passes that rung; recorded on an undeclared route it fails closed.
  - `fingerprint` changes when one byte of the judge file changes.
  - `fingerprint` on a missing judge path prints a value and exits 0, and compose plus persist with it yields the AE3 verdict.
  - A build draft with `reason: browser-unavailable` and a valid artifact composes `unevaluated` with a `reason` starting with that string.
  - `persist` writes the verdict and a `.gitignore` containing `*` in the base dir.
  - Every ported precedence case from the source still holds.
- **Verification:** `npm test` green; `node scripts/verdict.mjs rederive` on a forged empty PASS prints `derived: unevaluated`.

### U3. Capture, gate and evidence step

- **Goal:** `capture.mjs` makes credential-safe API captures, and `gate.mjs` and `attach-evidence.mjs` work against the new schema and persist dir.
- **Requirements:** R15, R16, R18, R22, R23
- **Dependencies:** U2
- **Files:** `skills/ko-acceptance-validator/scripts/capture.mjs`, `skills/ko-acceptance-validator/scripts/gate.mjs`, `skills/ko-acceptance-validator/scripts/attach-evidence.mjs`, `test/acceptance-validator/capture.test.mjs`, `test/acceptance-validator/gate.test.mjs`, `test/acceptance-validator/attach-evidence.test.mjs`
- **Approach:** KTD9, KTD10 and KTD13. Export the pure scrub and structure functions from `capture.mjs` so tests need no network beyond a loopback server. In `composeComment`, render a text evidence file as a fenced block cut at 40 lines with a `… (n more lines)` tail; keep the image reference set equal to the attach set.
- **Patterns to follow:** the source test lists for both modules; injected `deps` so no test calls `gh`.
- **Test scenarios:**
  - A capture with an `x-api-key` header and a body echoing a `--secret-env` value holds neither value on disk.
  - A non-loopback capture of `{"email":"a@b.c"}` holds `email` and `string` and not the address; a non-JSON body is marked omitted.
  - A URL off the target origin, including one reached by redirect, is refused.
  - A valid build PASS with matching sha and hash prints `would-pass`; a spec PASS prints `would-block: wrong-stage`.
  - A text evidence file renders as a fenced excerpt and never as `--attach`; an image does the reverse.
  - A 60-line text capture renders 40 lines plus the tail line.
  - A remote verdict whose only evidence is a text file is refused without `evidence_redacted: true`.
  - The heading is `### Acceptance verdict: **PASS** (advisory)`.
  - `ghArgs` uses bare `gh` with one `--attach` per image.
- **Verification:** `npm test` green; `--dry-run` in a scratch repo prints a comment body and writes no marker.

### U4. Judge, dimensions, format and test-context references

- **Goal:** the prose a project reads to define its judge, understand the four dimensions, write scenarios, and point its coding agents at them.
- **Requirements:** R3, R7, R11, R26
- **Dependencies:** U1
- **Files:** `skills/ko-acceptance-validator/references/judge-template.md`, `skills/ko-acceptance-validator/references/dimensions.md`, `skills/ko-acceptance-validator/references/gherkin-format.md`, `skills/ko-acceptance-validator/references/test-context.md`
- **Approach:** `judge-template.md` carries the R11 sections as fillable headings with one invented example each. `dimensions.md` generalizes the four definitions and their questions to pages and APIs; for an API, legibility means a caller can tell empty from failure, and convention-fit means matching the API's established status and shape patterns. `gherkin-format.md` carries the tag table, the `held`/`manifested` meaning, the prose-voice rule with its API exception (KTD8), and three exemplars that lint clean, one on an API route. `test-context.md` carries the R26 snippet and table.
- **Patterns to follow:** the source `gherkin-format.md` structure; README prose register.
- **Execution note:** smoke-first — fill the template for a scratch repo and check every section has an answer.
- **Test expectation:** none — prose. U6's sweep, link and exemplar-lint checks cover it.
- **Verification:** all exemplars in `gherkin-format.md` pass `gherkin.mjs lint`; the filled template drives one spec run in the scratch repo.

### U5. SKILL.md and stage references

- **Goal:** the entry routing and the two stage procedures, naming no project and no required skill.
- **Requirements:** R3, R8, R9, R12, R13, R14, R15, R17, R18, R24
- **Dependencies:** U2, U3, U4
- **Files:** `skills/ko-acceptance-validator/SKILL.md`, `skills/ko-acceptance-validator/references/build-stage.md`, `skills/ko-acceptance-validator/references/verdict-schema.md`, `skills/ko-acceptance-validator/references/gate-consumer.md`
- **Approach:** frontmatter `name: ko-acceptance-validator` with an argument hint for `spec` and `build`. Scripts are invoked as `node <skill-dir>/scripts/<x>.mjs`, resolved as `skills/ko-multi-worker-pm/SKILL.md` does. The spec procedure adds the judge-draft step (R10) and a lint step after writing. The build procedure replaces the browser-skill invocation with driver selection (R14), adds the API branch (KTD8, KTD13) and the route table the stage builds itself (R17), and keeps review posture with the base-branch judge (R9, R18). `verdict-schema.md` documents the new token, the three rungs, and KTD6's `route` meaning. `gate-consumer.md` ends at the posture table.
- **Patterns to follow:** the source `SKILL.md` and `build-stage.md` step order; `skills/ko-multi-worker-pm/SKILL.md` for `<skill-dir>` wording.
- **Execution note:** smoke-first — walk both stages in the scratch repo before polishing.
- **Test expectation:** none — prose. U6 covers names and links.
- **Verification:** each of AE2, AE3, AE5 and AE7 traces to an explicit instruction in the prose, and no line names a project or a required skill.

### U6. Repo guards and conformance test

- **Goal:** the checks behind R1, R2 and R4 fail when broken.
- **Requirements:** R1, R2, R4
- **Dependencies:** U1–U5
- **Files:** `test/private-sweep.mjs`, `test/acceptance-validator/guards.test.mjs`, `test/meeting-prfaq.test.mjs`, `package.json`, `package-lock.json`
- **Approach:** KTD11. Extract `sweepPrivate`, `ngrams`, `lineHits`, `linkProblems` and `absoluteHits` into `test/private-sweep.mjs` taking the hash set as a parameter, and keep `test/meeting-prfaq.test.mjs` passing unchanged. The new test sweeps the skill folder, this plan and `README.md` with the extended hash set, checks imports and links, lints every `references/*.md` fenced `gherkin` block, and runs the conformance pair over the fixtures. Add `@cucumber/gherkin` and `@cucumber/messages` as exact-pinned devDependencies.
- **Patterns to follow:** `test/meeting-prfaq.test.mjs` self-tests with planted tokens; `skills/ko-multi-worker-pm/scripts/portability.test.mjs` import rule.
- **Test scenarios:**
  - A clean pass over the skill folder, this plan and the README reports no hits.
  - A planted token added as a hash is reported with file and line.
  - Every shipped `.mjs` imports only `./` siblings or `node:` specifiers; a synthetic `import x from "yaml"` fails.
  - Every relative link in the skill resolves inside it.
  - Every `valid/` fixture is accepted by both parsers.
  - Every `invalid-syntax/` fixture is rejected by both parsers, with a line number from the shipped lint.
  - Every `invalid-contract/` fixture is accepted by the official parser and rejected by the shipped lint with a line number.
  - No skill file, this plan or the README holds an absolute local path.
  - Every fenced `gherkin` block in `references/` lints clean.
  - `test/meeting-prfaq.test.mjs` still passes after the extraction.
- **Verification:** `npm test` green locally.

### U7. README and install smoke

- **Goal:** users can find, install and start the skill.
- **Requirements:** R1, R27
- **Dependencies:** U1–U6
- **Files:** `README.md`
- **Approach:** add the Skills-table row and the `## ko-acceptance-validator` section. Prerequisites: node 22, a `gh` with `comment --attach`, a browser tool such as `agent-browser`, `curl` or equivalent. Configuration: `docs/acceptance/judge.md`, drafted on first run. Usage: the `spec` and `build` lines plus `node <skill-dir>/scripts/gherkin.mjs scenarios <file>` for coding agents.
- **Execution note:** packaging; verify with the install smoke in the Verification Contract.
- **Test expectation:** none — docs. U6 sweeps the README.
- **Verification:** `npx skills add <this checkout> -s ko-acceptance-validator` into a scratch repo installs `references/` and `scripts/` intact and `node <skill-dir>/scripts/gherkin.mjs lint` runs with no install.

---

## Verification Contract

| Gate | Command / check | Proves |
|---|---|---|
| Unit and guard tests | `npm test` | R1, R2, R4, R5, R6, R19, R20, R21, R22, R23, R25, and existing suites still green |
| Conformance | `npm test` (the U6 fixture pair) | R4: everything the shipped lint accepts, the official parser accepts, over the fixture set |
| Install smoke | `npx skills add <this checkout> -s ko-acceptance-validator` into a scratch repo, then `gherkin.mjs lint` on an exemplar | R1 |
| Judge smoke | `spec` in a scratch repo with no judge, non-interactive, then interactive | R10 (AE3): unevaluated first, drafted and confirmed second |
| Spec smoke | `spec` on a short synthetic plan in the scratch repo | R8, R12, R13: `.feature` written, lint clean, verdict persisted with `.gitignore` |
| Build smoke, pages | `build` against a scratch app on localhost using `agent-browser` | R14, R17, R19 |
| Build smoke, API | `build` with no browser tool on PATH, on a scenario tagged with an API-prefix route, then `attach-evidence.mjs --dry-run` | R14, R16, R23 (AE5): scrubbed text capture, fenced excerpt, no attach |
| Remote refusal | `attach-evidence.mjs --dry-run` on a verdict with a non-loopback `target_url` and no `evidence_redacted` | R23 |
| Corpus smoke (operator-run) | `gherkin.mjs lint` over every `.feature` in the source project's plan directory | R4, R5: the 133 parser-valid files clean, 6 fail with line numbers, 2 warnings for a missing `When`; a difference is investigated, not forced |
| Docs review | read the README section against R27 | R27 |

## Definition of Done

- Every requirement traces to a file committed on the local branch and passes its gate above.
- `npm test` is green locally. Hosted CI follows only if the user asks to push (KD7).
- No source-project literal, local path or required-skill name remains in the skill, this plan or the README.
- Scratch repos, evidence folders and abandoned attempts are removed from the diff. The plan in `docs/plans/` is committed with the skill.

---

## Sources

- The source skill: `SKILL.md` and its references for judge, Gherkin format, build stage, verdict schema and gate consumer (behavioral reference only, not copied).
- The source project's scripts: verdict shim, gate, evidence step and their tests (ported with renames and the KTD5–KTD10 deltas); its sign-in, replay and hook scripts (dropped).
- Official parser survey over the source project's 139 `.feature` files: 6 fail, 89 of 911 scenarios declare several routes, 2 lack a `When`, 3 use `Background`, none use `Rule`, `Scenario Outline` or feature-level tags.
- `test/meeting-prfaq.test.mjs`: hashed private sweep and link checks to extract.
- `skills/ko-multi-worker-pm/scripts/portability.test.mjs`: sibling-import rule; `skills/ko-multi-worker-pm/SKILL.md`: `<skill-dir>` invocation wording.
- `test/setup.mjs` and `vitest.config.mjs`: frozen clock and test globs.
- `docs/plans/2026-09-30-0939-feat-meeting-notes-prfaq-skills-plan.md`: shape exemplar.
