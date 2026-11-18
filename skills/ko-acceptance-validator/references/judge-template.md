# Judge file template

Every fact about a project lives in its judge file, `docs/acceptance/judge.md` by default. The skill itself knows nothing about any project. Editing this file changes the judge fingerprint, so older verdicts stop matching.

Copy the headings below, keep them in this order, and replace each example. The examples describe an invented online shop.

---

# Acceptance judge

## Who judges

Name the person, what they care about, and how they talk. Findings are written in this voice.

> A support lead who answers customers all day. They think in jobs, not code. They want to look at a screen and know what to do next, and they flag anything ambiguous early. "When I open this order I can't tell if it shipped."

## Where the job is named

Where the canonical job, its entry point and its success path are written down, used for workflow-fit and intent-match. Cite paths rather than restating them.

> `docs/glossary.md` names the jobs. Refunds start from the order page, never the customer list, and succeed when the customer gets the refund email.

## Where conventions live

The UI and API conventions, used for legibility and convention-fit.

> `docs/design.md` for states and action colors. `docs/api.md` for status codes and error shape.

## Anchor cases

At least one case per dimension that this judge would reject, so the rubric has teeth. Real past cases are best. Label an invented one `(hypothetical)`.

- **Workflow-fit:** the bulk refund screen could only be reached from an admin menu support never opens.
- **Legibility:** the refund list showed dashes with no way to tell "none yet" from "failed to load". (hypothetical)
- **Intent-match:** the request was "refund a whole order"; what shipped refunded one line at a time.
- **Convention-fit:** a red button that meant "continue", when red means "stop" everywhere else. (hypothetical)

## Running the app

- **Start command:** `npm run dev`
- **Local URL:** `http://localhost:3000`
- **API base prefixes:** `/api/`. A `@route:` under one of these is called over HTTP; any other route is a page.
- **Where routes are defined:** `src/routes.ts` for pages, `src/api/` for endpoints. Used to map a diff to the routes it touches.

## Signing in

Names of environment variables only, never their values, and how to use them.

> Page sign-in: open `/login`, fill the email from `E2E_EMAIL` and the password from `E2E_PASSWORD`, submit, and wait for the account menu. API calls: pass `--header-env Authorization=E2E_API_TOKEN --secret-env E2E_API_TOKEN` to `capture.mjs`.

## Remote safety

- **Hosts that show real data:** `*.preview.shop.example`
- **Test record:** order `TEST-1`. The only record a run on one of these hosts may write to, passed as `--test-record`.
- **Selectors to blur:** `main :is(h1, h2, h3, p, td, li, dd, dt, input, textarea, select)`
- **Reading the deployed revision:** `GET /version` returns the commit SHA.
