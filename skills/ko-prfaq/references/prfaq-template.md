# PRFAQ template — the canonical anatomy

Fill this in per feature. Structure every Markdown PRFAQ exactly like this. `<...>` are slots; drop the guidance comments in your output.

---

```markdown
# <Feature Name> — PRFAQ

**<One bold sentence defining the feature and the outcome it creates. Concrete, not aspirational.>**

<!-- "Reads with" note — include ONLY if this PRFAQ overlaps a sibling. Blockquote naming the sibling doc and which doc owns which story. Link, don't repeat. -->
> Reads with [<Sibling Feature>](<sibling>-prfaq.md), which owns <the shared story>. This doc owns <this doc's story>.

---

## How to read this

This document has two parts:

- **Part 1 — Press Release** paints the vision: why <feature> matters and where it's going. It is intentionally aspirational.
- **Part 2 — FAQ** is the ground truth: what is built today, what is still planned, and the precise answers to the things people keep getting tangled on.

Throughout, capability status is marked. **These describe build state, never production** — pick words that can't be misread as "shipped/live to a customer" unless the thing truly is:

- 🟢 **BUILT** — implemented; works in a dev sandbox. NOT deployed to production. (Never use "LIVE" for something that isn't actually in production.)
- 🟡 **PARTIAL** — partly built / not wired end-to-end (a screen whose action is stubbed, a read path with no writer, a lib whose backend isn't connected).
- 🔵 **PLANNED** — designed or named only; not built.

<!-- Production banner — include when NOTHING (or little) is actually in production, so no reader mistakes 🟢 for shippable. -->
> ⚠️ **Nothing here is in production.** Every 🟢 BUILT means "works in a dev sandbox," not "live to a customer" — <the system-wide blocker, e.g. still gated on connecting the production CRM>.

<!-- Vocabulary note — include ONLY when a term has a naming trap (gets misheard / collides with a common word). -->
**One vocabulary note up front:** <term> means <X>, not <the thing people assume>.

---

## Part 1 — Press Release

<!-- Write a TRUE Amazon "Working Backwards" press release — as if announcing the launched product. Aspirational voice is fine here; the FAQ below carries the ground truth. Follow this order exactly. -->

### <Headline as a claim — what the feature turns "before" into "after">

*<Sub-headline — one italic sentence naming the target customer and the core benefit.>*

**<CITY>, <ST> — <Month YYYY> —** <Dateline + summary: 2–3 sentences a reader could stop after and still get the gist — who it's for, what it is, why it matters.>

<The problem — one paragraph naming the real pain with concrete numbers/examples from the source, not abstractions.>

> "<Verbatim problem/vision pull-quote from the transcript.>" — <Speaker> (<source meeting>, ~M:SS)

<The solution & how it works together — 1–2 paragraphs explaining how the pieces work AS A SYSTEM: name the mechanics in plain language and show the parts interacting (this feature in the context of the surrounding apps/services). This is the heart of the PR — describe things and their workings together, not just the value.>

> "<Verbatim solution pull-quote from an internal stakeholder — the spokesperson quote.>" — <Speaker> (<source meeting>, ~M:SS)

<Customer experience — a short "here's what it's like" narrative walking the primary persona through the feature end to end.>

<!-- Exactly one illustrative testimonial, clearly labeled. Never fabricate a real attribution. -->
> "<Illustrative testimonial from the primary persona.>" — *illustrative <role>*

<Closing — the repeatable motion this unlocks + a one-line, honest availability note (e.g. "rolling out as X connects"). What stays a first-class path even after this ships.>

---

## Part 2 — FAQ

### A. What it is and why

**Q: What is <feature>, in one sentence?**
<One-sentence answer FIRST.>

**Q: <The framing question people keep asking — e.g. "is it a tag or its own thing?">**
<Answer, status-marked if it describes a capability.> 🟢 **BUILT** / 🟡 **PARTIAL** / 🔵 **PLANNED**

**Q: Why <this> instead of <the obvious alternative>?**
<Answer grounded in the real constraint.>

---

### B. What's BUILT today vs PLANNED

<The single most important section. One line of framing, then the table. `Where` is a REAL repo-relative path found by searching the code — not recalled. 🔵 rows point at a design doc, plan, or the meeting summary that named it; never leave `Where` blank or absolute.>

| Capability | Status | Where |
|---|---|---|
| <Capability that works in dev today> | 🟢 BUILT | `<real/code/path/>` |
| <Built but not wired end-to-end> | 🟡 PARTIAL | `<real/code/path/>` |
| <Designed, not built> | 🔵 PLANNED | `<design doc, plan, or ../meeting-notes/.../summary.md>` |

**Q: What can I actually do right now?**
<The honest BUILT answer — what works in a dev sandbox, and what is actually in production.>

**Q: <The "can users do X end-to-end today?" question>**
<Honest answer about what's not closed yet.> 🟡 / 🔵

---

### C. <Feature-specific thread — a model, a comparison, or how the pieces connect>

<Use a side-by-side table for two-model comparisons, or a numbered `create → publish → join`-style list for a flow. Status-mark each step.>

---

### D. The tricky bits

<Data-model traps, naming collisions, legacy fields, "why are there three of X" — the things that cause repeated confusion. Q&A form.>

---

### E. Open questions still being decided

These are genuinely unsettled — **don't treat them as decisions:**

- **<Open question>** — <the tension / the leaning, explicitly not resolved>.
- **<Open question>** — <...>.

---

## Appendix

### Glossary

| Term | Meaning |
|---|---|
| <term> | <plain-language meaning> |
| `<fieldName>` | <what it actually holds, especially if the name is misleading> |

### Source index

- **Transcripts / notes:** <links relative to `docs/prfaqs/` — `../meeting-notes/<series>/<date>/<date>-summary.md` and the deep-linkable transcript when it exists; or "conversation, <YYYY-MM-DD>">.
- **Meeting updates:** <one line per later meeting that refined this PRFAQ, linked to its summary>.
- **Related PRFAQs:** <links to siblings that share a spine>.
- **Code:** <real file paths backing the status markers>.
```

---

## Voice reminders

- Settle questions people keep getting tangled on. Every FAQ answer should resolve a recurring confusion.
- The Press Release is allowed to be aspirational; **the FAQ is not** — it is ground truth, status-honest.
- Capture the team's own skepticism and caveats, not just the pitch.
- One-sentence version first in each FAQ answer, then the detail.
- Never declare a resolution the transcript didn't reach — unsettled goes in Open Questions.
