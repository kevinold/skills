# PRFAQ promotion bar — what earns a standalone PRFAQ, and how it's structured

The reusable recipe for turning meeting notes into PRFAQ artifacts. `meeting-notes` and `prfaq` each ship an identical copy of this file. A PRFAQ is not a spec and not a plan. A spec says how to build; a plan sequences the work; a PRFAQ explains the feature to every role at once (ops, GTM/leadership, engineering) and is honest about what's already real versus aspirational. Its defining job is to **end recurring confusion** — every section earns its place by resolving something people kept getting tangled on.

## 1. Identify the inputs

Expect a meeting transcript (frequently a `.docx`, which is not deep-linkable) or a `<date>-summary.md` written by `meeting-notes`. Optionally expect a structured "priority projects" note that has already tagged features as **Big** or **Small** with an effort estimate and a Problem/MVP/Prerequisite framing. The transcript is the source of debates, quotes, and open questions; the priority note is the source of problem framing and the selection filter.

## 2. The selection bar — one PRFAQ per qualifying feature

A feature earns a standalone PRFAQ only if it is **big/major AND requires cross-team coordination AND has genuine questions/discussion in the transcript**. Apply the filter two ways:

- **With a priority note:** use the **Big tag as the primary filter**. Big-tagged items that were actually debated get a PRFAQ; Small-tagged items do not (they fold in as dependencies — see §7).
- **Without a priority note:** infer the same bar from the transcript — depth of discussion, breadth of the coordination surface, and the presence of unresolved open questions. A feature mentioned once with no debate does not qualify.

A topic that already has a PRFAQ is never a new candidate. The meeting's changes to it are **refinements**, applied to the existing doc.

## 3. Scope gate before drafting (ask the user two questions)

Do not start writing until you've confirmed:

- **(a) Grouping/splitting** — one PRFAQ per feature, or a themed cluster? Default is one-per-feature; features that share a dependency still get separate docs that cross-link rather than merge.
- **(b) Depth** — plan-blueprint-only this turn, or draft the documents now?

## 4. PRFAQ anatomy

Follow `prfaq-template.md` in the `prfaq` skill. Every Markdown PRFAQ has, in order: title + bold one-sentence definition; a "How to read this" block (PR = vision, FAQ = ground truth) with the status legend; Part 1 Press Release (headline, narrative, real transcript pull-quotes cited *(Speaker, ~M:SS)*, and exactly one clearly-labeled *illustrative* testimonial); Part 2 FAQ (grouped A/B/C… sections, each answer status-marked, always including a "What's BUILT today vs PLANNED" table and an "Open questions still being decided" block); Appendix (glossary + source index).

The status legend describes build state, never production:

- 🟢 **BUILT** — implemented; works in a dev sandbox. Not in production.
- 🟡 **PARTIAL** — partly built / not wired end-to-end.
- 🔵 **PLANNED** — designed or named only; not built.

Never write "LIVE" or "shipped" for something that isn't actually in production.

## 5. Ground every status marker in an actual codebase scan — never blanket-PLANNED

Before assigning 🟢/🟡/🔵 to any capability, search the codebase for what already exists and anchor each marker to a real repo-relative path — code, or for 🔵 a design doc, plan, or the meeting summary that named it. Marking a built system PLANNED is wrong and erodes trust in the doc. Search, don't recall. Re-verify drift right before publishing; code moves faster than a plan.

## 6. Ship a dual deliverable: canonical Markdown + a self-contained HTML twin

Write the Markdown first (it is canonical), then hand-author an HTML twin from the `prfaq` skill's HTML shell:

- A **single `.html` file** with all CSS/JS inline, **no external dependencies/CDNs/fonts** (system font stack), rendering offline.
- **Colored status chips** (not emoji-in-prose), the BUILT-vs-PLANNED table and any comparison rendered as real tables/grids, a **collapsible `<details>` FAQ**, a **sticky in-page jump-nav**, the Open Questions block as a distinct callout panel, and **one signature inline-SVG diagram per feature** capturing its most spatial idea.
- **Parity is mandatory:** the HTML must hold identical substance — same claims, status markers, quotes, open questions — as its Markdown sibling. Build the HTML from the finished Markdown so parity holds by construction; do not use a generic md→html converter.

## 7. Place and link correctly

All artifacts live in `docs/prfaqs/`, named `<feature-kebab>-prfaq.{md,html}`. `docs/prfaqs/README.md` is one index table — `PRFAQ | One-liner | Source | md | html` — with one row per PRFAQ. Source is the meeting-notes summary (linked) or "conversation, <YYYY-MM-DD>". Then:

- **Every PRFAQ links back to its source meeting notes** in its source index, relative to `docs/prfaqs/` (`../meeting-notes/<series>/<date>/<date>-summary.md`), and names the origin in prose.
- **Related PRFAQs cross-link a shared spine** — state shared material canonically in one doc and link to it from the other; never duplicate it.
- **Dependency-only (Small-tagged) features fold in as dependencies**, described as upstream signals inside the consuming PRFAQ, not re-pitched as standalone docs.
- **Unsettled debates stay flagged as open** in the "Open questions" block — never declare a resolution the transcript didn't reach.

## When NOT to write a standalone PRFAQ

- The feature is small, was barely discussed, or has no real open questions — fold it into a larger PRFAQ as a dependency.
- The user wants an implementation spec or a sequenced work plan — that's plan/spec territory. A PRFAQ explains and settles; it does not sequence the build.
- Two candidate docs would largely overlap — collapse them via a shared-spine cross-link instead of producing duplicates.
- The topic already has a PRFAQ — refine that one instead.
