# Scenarios as context for coding agents

The `.feature` file says what the judge will check. A coding agent that reads it first writes tests that line up with that judgment. The skill generates no test code and runs no BDD runtime, so tests stay in the project's own runner and style.

## Snippet for your agent instructions

Paste this into the file your coding agents read, such as `AGENTS.md` or `CLAUDE.md`, replacing `<skill-dir>`:

```markdown
When a plan has a `.feature` file beside it, read its scenarios before writing tests:
`node <skill-dir>/scripts/gherkin.mjs scenarios <file> [--route x] [--kind y] [--dimension z]`.
Cover each scenario at the layer its route implies, and carry the scenario's `id` in the test's title.
Assert every `Then` of a `@kind:good` scenario, and assert that the rejection mode of a `@kind:bad`
scenario does not appear. Never edit a `.feature` to make a test pass: if a scenario is wrong, say so,
because changing the file voids its acceptance judgment.
```

## What the command returns

A JSON list, with `Background` steps folded in first:

```json
[
  {
    "id": "reorder-starts-from-the-order-i-am-looking-at",
    "name": "Reorder starts from the order I am looking at",
    "kind": "good",
    "dimension": "workflow-fit",
    "routes": ["/orders/:id", "/checkout"],
    "steps": [{ "keyword": "Given", "text": "I am looking at a past order" }],
    "line": 4
  }
]
```

On a malformed file it prints the lint errors to stderr and exits 1.

## From tags to tests

| Tag | What it tells the test |
|---|---|
| `@kind:good` | Assert each `Then` and `And` after it. |
| `@kind:bad` | Set up the situation in the steps and assert the rejection mode is absent. The steps describe what must not happen. |
| `@route:` page | An end-to-end or component test, starting from that route. |
| `@route:` API path | An integration test calling that method, asserting the named status and body. |
| `@dimension:workflow-fit` | Start from the entry point and finish at the outcome, not in the middle. |
| `@dimension:legibility` | Assert the loading, empty and error states are each distinct. For an API, assert empty and failure differ by status or body. |
| `@dimension:intent-match` | Assert the outcome the request named, not an intermediate step. |
| `@dimension:convention-fit` | Mostly left to the build-stage judge. Assert only what is mechanical, such as a shared component being used or an error shape matching. |

## Rules

- **The test title carries the scenario id**, for example `reorder-starts-from-the-order-i-am-looking-at: new order holds the same items`. A later reader can then trace a test to the judgment it supports.
- **A `.feature` is never edited to make a test pass.** The build stage hashes the file, so a changed file requires a fresh spec judgment.
- **A passing test is not a verdict.** Tests show the change works. The build stage still judges whether it is the thing the person needed.
