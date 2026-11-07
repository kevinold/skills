# The shared `.feature` artifact

The spec stage writes one Gherkin `.feature` file next to the plan and commits it with the plan. The build stage hashes the same bytes and walks the same scenarios, and coding agents read them when writing tests. The skill runs no BDD runtime: an agent judges the file and `scripts/gherkin.mjs` reads it.

It is real Gherkin. Any file that passes `gherkin.mjs lint` also passes the official Gherkin parser, so a project may bind the same file with its own BDD runner. The skill neither requires nor configures one.

## Default location

`<plan-dir>/<plan-basename>.feature`, for example `docs/plans/2026-03-01-reorder-plan.feature`. `--feature <path>` overrides it. In review posture the file goes to `.tmp/acceptance/review-<PR>.feature` and is never committed.

## Syntax the lint accepts

- One `Feature:`, with optional description text under it.
- An optional `Background:`, before any scenario, with no tags.
- `Scenario:` or `Example:`, each with a name and steps.
- `Rule:` to group scenarios.
- Steps start with `Given`, `When`, `Then`, `And`, `But` or `*`. Each step stays on one line. A wrapped line is a syntax error, and `So I can…` is not a step.
- A data table or a doc string may follow a step.
- `# language:` may only be `en`.
- `Scenario Outline` and `Examples` are rejected, because one scenario id cannot show that every row was observed. Write each case as its own `Scenario`.

## Tag grammar

Three tags are the only machine-read surface. Everything else is prose. Put them on the line above each `Scenario:`. A tag above `Feature:` or `Rule:` is inherited by the scenarios under it, as in standard Gherkin. A tag in a comment never counts.

| Tag | Values | Meaning |
|---|---|---|
| `@kind:` | `good` \| `bad` | A `good` scenario asserts the job succeeds. A `bad` scenario asserts a rejection mode, the thing that would make the judge reject. |
| `@dimension:` | `workflow-fit` \| `legibility` \| `intent-match` \| `convention-fit` | Which dimension the scenario exercises. See [`dimensions.md`](dimensions.md). |
| `@route:` | a path | The surface the scenario is walked on, a page or an API endpoint. Declare every route the job needs, not only the changed page. |

Each scenario has exactly one `@kind`, exactly one `@dimension`, at least one `@route`, and at least one `Then`. Names must stay unique once slugged, because the slug is the scenario's id. A missing `Given` or `When` is a warning.

A route is a path-only reference: it starts with one `/` and uses letters, digits and `. _ ~ : / ? = & % # -`. `/orders/:id` and `/admin#team` are fine. `//host/x` and `/x$(y)` are not.

**`good` and `bad` at build time.** A `good` scenario is `held` when it holds on the running app. A `bad` scenario is `held` when its rejection mode correctly fails to appear, and `manifested` when it appears, which is a reject signal.

## Prose voice

Write every step as the person in the judge file doing their job, in the voice that file defines. No code, no component names, no selectors. If a step could only be understood by reading the source, it is wrong for this file. The tags carry the machine meaning; the prose carries the job.

**The exception is an API route.** Its user is an API caller, so a scenario on one names its HTTP method and expected status in its steps. The build stage reads them from there. With no method named, the route is skipped and the verdict stays `unevaluated`.

## Exemplars

A `good` scenario, where the job connects end to end from where the person works:

```gherkin
Feature: A customer reorders from their history

  @kind:good @dimension:workflow-fit @route:/orders/:id @route:/checkout
  Scenario: Reorder starts from the order I am looking at
    Given I am looking at a past order
    When I choose "Order again"
    Then a new order holds the same items
    And I land on checkout
```

A `bad` scenario, a rejection mode that should not appear at build time:

```gherkin
Feature: A customer reads their order history

  @kind:bad @dimension:legibility @route:/orders
  Scenario: An empty history cannot be told apart from a broken one
    Given I have never bought anything
    When I open my orders and the page shows no message
    Then I cannot tell "nothing yet" from "this is broken"
```

A scenario on an API route:

```gherkin
Feature: Partners read a booking over the API

  @kind:good @dimension:legibility @route:/api/bookings/:id
  Scenario: A booking with no notes says so
    Given a booking with no notes exists
    When a partner calls GET on that booking
    Then the response status is 200
    And the notes field is an empty list
```
