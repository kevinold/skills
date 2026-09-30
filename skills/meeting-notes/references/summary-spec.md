# Summary Spec — the PM-grade meeting summary contract

What `<date>-summary.md` must contain and how it must read. A summary that only lists outcomes is a minutes file, not a PM artifact.

## Two shapes

- **Long form** (multi-person feature calls, substantive debate) — the full section catalog below.
- **Short form** (small two-person calls, little debate) — acceptable when the call was light: title `# <Participants> — <date> — <Topic>`, a headline decision, a key-points list, a short side-observations list, and the closing PRFAQ section (one line when nothing qualifies). Skip the deep-dive H2 machinery.

Pick the shape from the transcript, not a rule. When in doubt, long form.

## Section catalog (long form, in order)

1. `# <Series> — Meeting Summary (<YYYY-MM-DD>)`
2. `**Topic:**` paragraph — what the call was about and why it happened now.
3. Metadata bullet block: `**Participants:**`, `**Duration:**`, `**Source transcript:**` (source-doc link `·` "deep-linkable text:" md link), `**<Tool> summary (source):**` when one was filed, `**Recording + screen timeline:**` when the video pass ran, side-artifact links, `**Upstream:**` (prior meetings / priority lists this call continues), related/refined PRFAQ links.
4. Optional `> **Why this call matters:**` blockquote — the one-paragraph stakes statement.
5. `---`
6. `## TL;DR — what we decided` — numbered list; each item is a bold decision sentence, detail, and attributions.
7. `## Vocabulary decisions` — **include whenever the meeting established, renamed, locked, or deprecated a canonical term.** Each: the term, what changed (new / renamed-from / locked / deprecated), and attribution. When the repo has a `CONCEPTS.md`, these are also persisted there in the same change (see SKILL.md "Canonical vocabulary"). Omit the section only when the meeting decided no vocabulary.
8. Deep-dive H2 per major thread, H3 subsections; timestamp ranges in headings for minor threads (`### Onboarding checklist (12:16–25:17)`). ASCII/mermaid diagrams allowed where structure helps. When a committed frame shows what was on screen for a thread, say so in prose and point at the timeline row; don't embed the image.
9. `## Open questions still being decided` — grouped by bold sub-labels, attributed; explicitly *not* decisions.
10. `## Action items` — `- [ ] **Owner** — task (Name, ~M:SS)`.
11. Closing PRFAQ section — refinements vs net-new candidates (see SKILL.md PRFAQ handoff).

**Anchor stability:** H2 heading text becomes link anchors that downstream PRFAQs deep-link (e.g. `2026-06-08-summary.md#notification-architecture`). Choose heading text you can keep; once committed, treat it as frozen.

**Link conventions:** bare filenames within the dir; `../../<series>/<date>/...` across series; `../../../prfaqs/<name>-prfaq.md` to PRFAQs.

## PM analysis lenses (mandatory, not optional polish)

Every lens below must be represented when the transcript contains it; weave lenses into the TL;DR and deep-dives rather than bolting on empty sections.

- **Decisions with their reasoning** — what landed AND the constraint or evidence that drove it. Not just "we chose X" but "we chose X because Y ruled out Z."
- **Competing ideas and disagreements** — both sides, who pushed back, and the landing point (or explicit non-resolution). Never flatten a debate into its winner. Record who argued what and where it landed — or that it didn't.
- **Questions raised** — asked on the call, answered or not. Unanswered ones land in Open Questions.
- **Open questions / unsettled debates** — flagged explicitly as "still being decided"; never declare a resolution the transcript didn't reach.
- **Insights and nuances** — observations that change how the team should think, even without a decision.
- **Challenges and risks** — operational or adoption obstacles named on the call, with who raised them.
- **Verbatim pull-quotes** — italicized with attribution, lift-ready for PRFAQs: `*"Nobody should have to check three places to find the right contact"* (Priya, ~35:30)`.

## Attribution MUSTs

- Format: `(Name, ~M:SS)` under one hour; `(Name, ~H:MM:SS)` at/past the hour — matching the transcript's own stamps. Ranges: `~30:26–31:05`, `~58:12–1:03:40`. Multi-speaker: `(Marcus, ~38:17; Priya, ~47:51)`.
- The tilde is always present — timestamps are approximate turn starts.
- **Never fabricate.** Every timestamp must correspond to a real turn line in the transcript `.md`. No timestamps in the source → `(Name)` only, and the metadata block notes "timestamps unavailable in source."
- **Post-write verification pass (required):** grep the transcript for every `(Name, ~timestamp)` cited; correct or downgrade any miss to `(Name)`. Zero misses before the summary is offered. Downstream PRFAQs lift these citations verbatim — a shifted timestamp poisons every doc downstream.

## Privacy

The summary is committed, and repos get shared. Keep third-party customer names, personal names of people outside the team, production record identifiers, and amounts from live systems out of it unless the team has already published them. Describe them generically ("a large customer's renewal deal"). Say so in one `> **PII redaction.**` blockquote under the metadata block when you generalized anything.

## Voice

Settle what people keep getting tangled on. Capture the team's own skepticism, not just the pitch. Decisions read as decisions; open items read as open. Concrete numbers and real examples over abstractions.
