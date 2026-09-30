---
name: prfaq
description: Generate or update a PRFAQ (Amazon-style Press Release + FAQ) pair — canonical Markdown plus self-contained HTML twin — in docs/prfaqs/, following a status-honest, codebase-grounded format. Use when the user asks for a PRFAQ, says "/prfaq", wants meeting notes or a transcript turned into a PRFAQ, wants a meeting's prfaq-refinements file applied to existing PRFAQs, or wants an existing draft converted into the docs/prfaqs format. Input is usually a meeting summary from the meeting-notes skill, a transcript, a refinements file, or a feature discussion.
---

# PRFAQ Generator

Produce a feature PRFAQ as a **Markdown doc (canonical) + self-contained HTML twin**, registered in `docs/prfaqs/README.md`, or update an existing one when a later meeting refines it.

## Inputs and mode

| Input | Mode |
|---|---|
| A `<date>-summary.md` from `meeting-notes`, a named candidate from its closing section, a transcript (`.docx` via `textutil -convert txt -stdout` or `pandoc -t plain`, or `.md`), or a feature discussion in conversation | **Create** |
| A `<date>-prfaq-refinements.md` from `meeting-notes`, or the name of an existing PRFAQ plus new source material | **Update** |
| An existing draft in another format | **Create** (convert it) |

If no source material is given, ask for it — a PRFAQ without source quotes and real examples is filler.

**Never overwrite.** In create mode, if `docs/prfaqs/<name>-prfaq.md` already exists, stop and ask: update that PRFAQ, or pick a new name. Never rename an existing PRFAQ; other docs deep-link its anchors.

## Selection and scope

Read [references/prfaq-promotion-bar.md](./references/prfaq-promotion-bar.md) before drafting. A feature earns a standalone PRFAQ only if it is **big/major AND cross-team AND genuinely debated**. Run the scope gate (grouping/splitting; blueprint-only vs draft-now) before writing.

## Format (template: `references/prfaq-template.md`)

Read the template before writing. Structure every PRFAQ as:

1. **Title** — `# <Feature Name> — PRFAQ`, then a one-sentence bold thesis.
2. **"Reads with" note** (only if it overlaps another PRFAQ) — blockquote naming the sibling doc and which doc owns which story. Link, don't repeat.
3. **How to read this** — Part 1 aspirational / Part 2 ground truth, plus the status legend. **Status describes build state, never production — never label something "LIVE" unless it truly is in production:**
   - 🟢 **BUILT** — implemented; works in a dev sandbox. Not in production.
   - 🟡 **PARTIAL** — partly built / not wired end-to-end.
   - 🔵 **PLANNED** — designed or named only; not built.
   - Add a **vocabulary note** when the feature has a naming trap.
   - Add a **production banner** (`> ⚠️ Nothing here is in production…`) when little/nothing is actually deployed, so no reader mistakes 🟢 for shippable.
4. **Part 1 — Press Release** — a TRUE Amazon "Working Backwards" press release, written as if announcing the launched product (aspirational voice OK; the FAQ carries the truth). Follow the order in the template: **(a)** headline as an `###` claim, **(b)** italic sub-headline (target customer + core benefit), **(c)** dateline + summary (`**<CITY>, <ST> — <Month YYYY> —**` then 2–3 sentences), **(d)** the problem paragraph with concrete numbers/examples, **(e)** a verbatim problem/vision pull-quote, **(f)** the solution & **how the pieces work together as a system** (name the mechanics; show parts interacting — this is the heart), **(g)** a verbatim leader/spokesperson pull-quote, **(h)** a customer-experience narrative through the primary persona, **(i)** exactly one clearly-labeled *illustrative* testimonial, **(j)** closing with the repeatable motion + an honest one-line availability note. Pull-quotes are **attributed with speaker + meeting** and `~M:SS` (`~H:MM:SS` past the hour) when the transcript has them — lift the citations from the meeting summary verbatim. Once a PRFAQ cites more than one meeting, write `(Name, <YYYY-MM-DD>, ~M:SS)` so each citation names its meeting. The dateline uses the team's home city, or `REMOTE` for a distributed team. Never fabricate a real attribution.
5. **Part 2 — FAQ** — lettered sections (`### A. What it is and why`, etc.). Every answer that describes a capability carries a status marker. Required sections:
   - *What it is and why* (one-sentence version first)
   - *What's BUILT today vs PLANNED* — the status **table** with `Capability | Status | Where` columns; `Where` is a real repo-relative path (code; for 🔵 a design doc, plan, or the meeting summary that named it) — never blank, never absolute. Search the codebase for each path before writing it — don't recall.
   - *The tricky bits* (data-model traps, naming collisions, legacy fields)
   - *Open questions still being decided* — explicitly marked "don't treat these as decisions"
6. **Appendix** — **Glossary** table and **Source index** (meeting notes, plans, related PRFAQs, code paths).

Voice: settle questions people keep getting tangled on. Be honest about caveats — capture the team's own skepticism, not just the pitch. Press release is allowed to be aspirational; FAQ is not.

**Conversation-sourced PRFAQs** have no transcript to quote. Quote the user's own words only with their consent, attributed `(<Name>, conversation, <YYYY-MM-DD>)`; otherwise leave the verbatim pull-quote slots out rather than inventing one. The illustrative testimonial stays, labeled.

## HTML twin

Fill in [references/prfaq-html-twin-shell.html](./references/prfaq-html-twin-shell.html) — a self-contained single file with **no external dependencies** (per [html-effectiveness](https://thariqs.github.io/html-effectiveness/)). The shell already carries the shared visual system so the suite stays uniform:

- CSS custom props: `--built:#1f9d57 --partial:#b8860b --planned:#2f6fed --accent:#2f6fed` palette.
- Sticky top nav with section pill links + two toggle buttons: **"Show only Planned"** (filters status-table rows via a `.filtering` class and `planned-row`/`head` row classes) and **"Expand all"** (opens every `<details>`). Every nav pill's `href` must match a section `id`.
- Hero header: kicker line (`PRFAQ · <source meeting> · <date>`), `h1`, `.lede` thesis, status-chip legend.
- One **signature inline SVG figure** near the top illustrating the core before/after or flow — hand-drawn `<svg>`, no images. Design it for this feature.
- FAQ items as `<details><summary>Q…</summary><div class="body">…</div></details>`; status chip stays inline in the text.
- Pull-quotes as `<blockquote>` with `<cite>`.
- `@media print` rules keep nav hidden and details expanded.

**Parity is mandatory:** build the HTML from the finished Markdown so every claim, status marker, quote, and open question matches. Do not use a generic md→html converter.

## Update mode

For each `## <name>-prfaq.md` section of a refinements file (or the one PRFAQ the user named):

1. Read the existing PRFAQ, its HTML twin, and the new source (the refinements section and the meeting summary it cites).
2. **Re-check every status row against the code**, not just the rows the refinements name. Code moves between meetings; update the marker and `Where` path to what the search shows.
3. Apply the claim changes. Then re-read the Press Release and FAQ prose against the updated table — prose lags tables; fix any sentence that now contradicts a marker.
4. Move resolved open questions into the FAQ answer they settled (with the citation); add the new open questions.
5. Add the meeting to the Source index under **Meeting updates**. If this makes the PRFAQ cite a second meeting, rewrite its existing `(Name, ~M:SS)` citations as `(Name, <original meeting date>, ~M:SS)` in both files.
6. Rebuild the changed parts of the HTML twin from the updated Markdown, keeping parity. Keep existing heading text and anchor ids.
7. Update the README row's one-liner if the thesis changed.

A refinement the transcript didn't actually settle stays an open question — never upgrade it to a decision.

## File and registry conventions

- Filenames: `docs/prfaqs/<kebab-feature-name>-prfaq.md` and `.html`. Create `docs/prfaqs/` if it doesn't exist.
- `docs/prfaqs/README.md` (create it if absent) is one index table: `| PRFAQ | One-liner | Source | md | html |`. Add one row per new PRFAQ. Source links the meeting summary relative to `docs/prfaqs/` (`../meeting-notes/<series>/<date>/<date>-summary.md`), or reads `conversation, <YYYY-MM-DD>`. Note cross-links between PRFAQs as blockquote callouts below the table.
- If source notes for the meeting aren't in `docs/meeting-notes/` yet, say so — don't invent the link.
- Commit type: `docs:`. Follow the project's own branch/PR conventions.

## Workflow

1. Pick the mode from the input table; in create mode, check the target name is free.
2. Read source material fully; read `references/prfaq-template.md` and one recent pair in `docs/prfaqs/` (if any) for house drift.
3. Extract: the pain (with real numbers), the proposal, what already exists in code (search for paths — don't recall), explicit V1/out-of-scope boundaries, guardrails, costs, open questions, and the best 1-3 verbatim quotes.
4. Write (or update) the Markdown doc. Status-mark every capability claim.
5. Build (or re-sync) the HTML twin from `references/prfaq-html-twin-shell.html`; design the signature SVG for this feature's core idea.
6. Register in `README.md`.
7. Offer (don't auto-run) a `docs:` commit.
