---
name: ko-meeting-notes
description: File a raw meeting document (Teams/Zoom/Meet transcript .docx, or .md/.txt) into a docs/meeting-notes/ series/date taxonomy and write a PM-grade summary — decisions, competing ideas, disagreements with landing points, open questions, insights — with speaker + timestamp attributions, ending with PRFAQ refinements and candidates for the ko-prfaq skill. Optionally watches the meeting recording (or reads notetaker screenshots) to add a PII-gated screen-share timeline. Use when the user drops a meeting transcript, says "file this meeting", "summarize this transcript", "watch the recording", or "add the screen timeline", wants meeting notes organized, or wants to backfill a summary for an already-filed meeting.
---

# Meeting Notes — File & Summarize

File a raw meeting doc into `docs/meeting-notes/<series>/<YYYY-MM-DD>/` and write a summary a Product Manager could run a roadmap from. Selection/promotion rules for the PRFAQ handoff follow [references/prfaq-promotion-bar.md](./references/prfaq-promotion-bar.md).

## Inputs

- A `.docx` (Teams/Zoom/Meet transcript export) at the `docs/meeting-notes/` root — convert per **Transcript conversion** below.
- A `.md`/`.txt` — treat as the pre-converted transcript: skip conversion, add the provenance blockquote if absent, file as the transcript.
- **Optional:** a meeting recording (local file or URL) or notetaker screenshots — see **Video pass** below.
- **No unfiled doc at root** → report "nothing to file" and offer backfill mode on any filed dir missing its transcript or summary.
- **Multiple unfiled docs** → list them, ask which to process. Ignore `.DS_Store` and other noise files.
- **Recordings are never filed.** A video file (`.mp4`, `.mov`, `.webm`, `.mkv`, `.m4a`) found at the root, or anywhere in the notes tree, is never moved, copied, or committed. Reference it by basename only.

If `docs/meeting-notes/` doesn't exist yet, create it on first file.

## Entry modes

1. **File a new doc** — root doc → taxonomy (the normal path).
2. **Backfill** — an already-filed date dir is missing transcript and/or summary (e.g. it has only the raw docx): convert and summarize in place. Do not re-file or rename what's already committed.
3. **Re-run guard** — the target date dir already has a summary: ask **regenerate or stop**. Never silently overwrite. On regenerate: reuse the existing summary's H2 headings verbatim wherever content allows, and grep `docs/prfaqs/` for inbound anchor links first — any linked heading that must change requires updating the linking PRFAQ in the same change. Note: a pre-commit regeneration is recoverable only via git history.
4. **Video pass only** — the meeting is already filed and the recording (or screenshots) arrived later: run the video pass alone. See [references/video-pass.md](./references/video-pass.md).

## Series and date inference

- **Series:** kebab-case the filename's series segment and match against existing dirs under `docs/meeting-notes/`. "Exact" means the raw segment already equals a directory name byte-for-byte; **any** transformation (case-folding, space/underscore→dash, punctuation stripping) makes the match fuzzy — show the match and confirm before filing. Create a new series dir only on explicit user yes.
- **Date precedence:** filename date → transcript header date on line 1 of the doc (many exporters prefix `<Name>-YYYYMMDD_HHMMSS`) → file mtime. When sources disagree, prefer the filename and confirm (exporter header times can be UTC-shifted across midnight).

## Filing conventions

| Artifact | Pattern | Example |
|---|---|---|
| Directory | `<series-kebab>/<YYYY-MM-DD>/` | `product-sync/2026-06-08/` |
| Original docx | `<YYYY-MM-DD>-<Series-Title-Case>.docx` | `2026-06-08-Product-Sync.docx` |
| Transcript | `<YYYY-MM-DD>-<Series-Title-Case>-transcript.md` | `2026-06-08-Product-Sync-transcript.md` |
| Summary | `<YYYY-MM-DD>-summary.md` (invariant — never includes series) | `2026-06-08-summary.md` |
| Tool auto-summary | `<YYYY-MM-DD>-<tool>-summary.md` | `2026-06-08-otter-summary.md` |
| Screen timeline | `<YYYY-MM-DD>-screen-timeline.md` | `2026-06-08-screen-timeline.md` |
| Committed frames | `assets/video-frames/<HH-MM-SS>.jpg` | `assets/video-frames/00-14-20.jpg` |
| Side artifacts | `<YYYY-MM-DD>-<kebab-topic>.md` / `.html` | `2026-06-08-gap-analysis.md` |

- The root docx is untracked — move it with `mv`, not `git mv`.
- **Never retro-rename already-committed files** — published summaries and PRFAQs deep-link them; a rename breaks those anchors. Leave pre-convention filenames as they are.
- Ask once: any chat-shared files to file alongside (notes lists, gap analyses)? File as side artifacts and link them from the summary's metadata block.

## Transcript conversion and quality gate

1. **Extract to plain text:**
   - macOS: `textutil -convert txt -stdout "<docx>"`.
   - Cross-platform fallback: `pandoc -t plain "<docx>"`.
   - Neither available, or a non-docx binary → see step 3.
2. **Gate before writing:** output is non-empty AND contains speaker-turn lines — `Name   M:SS text` shape (name↔timestamp separator is plain spaces; timestamps roll to `H:MM:SS` past the hour). Beware: `textutil` delimits turn boundaries with invisible **U+2028 line separators**, not spaces — plain-text grep for `Name   M:SS` still matches, but `^ `-anchored regexes won't; match with `\s`-tolerant patterns. If the doc has no speaker turns (agenda/recap-only), still file it; the summary degrades to a notes digest and the no-timestamp attribution rule applies.
3. **On extraction failure** (no converter, or conversion produced nothing usable): still file the renamed docx, skip the transcript `.md`, set the summary's source line to "transcript not extractable," and continue.
4. Transcript file shape: `# <Series> — Meeting Transcript (<YYYY-MM-DD>)`, then a provenance blockquote (`> Auto-extracted from \`<docx>\` via \`<textutil|pandoc>\`. Speaker · timestamp · text. Unedited — auto-transcription artifacts remain.`), then `---`, then the extracted text verbatim. For a `.md`/`.txt` input, the same header and gate apply, and the blockquote reads `> Filed from \`<original filename>\` as provided. Speaker · timestamp · text. Unedited.`

## Summary

**Read [references/summary-spec.md](./references/summary-spec.md) in full before writing the summary.** It owns the section catalog and PM analysis lenses. Three safety MUSTs are load-bearing enough to restate here:

- **Never fabricate timestamps.** Attributions are `(Name, ~M:SS)`, or `(Name, ~H:MM:SS)` at/past the hour, matching the transcript's own stamps. Source has no timestamps → attribute `(Name)` only and note the absence in the summary header.
- **Unsettled stays open.** Never declare a resolution the transcript didn't reach — capture both sides and who pushed back, and either the landing point or an explicit open status.
- **Verify every attribution post-write.** For each `(Name, ~timestamp)` in the summary and the screen timeline, grep the transcript for a matching speaker + timestamp turn line. Any miss is corrected or downgraded to `(Name)`. Zero misses before the summary is offered.

### Preserve the source auto-summary

If the notetaker ships its own auto-summary (Otter, Fireflies, Zoom AI, Gemini, and similar tools), **keep it verbatim** — the team may want the original alongside the abstraction. File it as `<date>-<tool>-summary.md` and **link it from the summary's metadata block** (`**<Tool> summary (source):**`). Faithfully transcribe its sections (TL;DR, topics, action items, decisions, blockers) into clean markdown; do not rewrite or improve it — the abstraction is your voice, this artifact is the tool's. The side artifact links back to the abstraction and the transcript so all three are cross-linked. Its chapter list, when it has one, labels the screen timeline's sections.

## Video pass

When a recording (local file or URL) or notetaker screenshots are supplied, **read [references/video-pass.md](./references/video-pass.md) in full** and run it after the summary and **before** the PRFAQ handoff, so refinements can cite committed timeline rows. It writes `<date>-screen-timeline.md` and commits only frames that clear its PII gate.

- A recording needs the external [`watch`](https://github.com/bradautomates/claude-video) skill. Without it, file the transcript and summary, skip the recording's frame pass, and print this one line: `Install watch to add a screen timeline: npx skills add bradautomates/claude-video (or /plugin install watch@claude-video in Claude Code).`
- Screenshots alone need no `watch`.
- Link the timeline from the summary's metadata block: `**Recording + screen timeline:** <recording basename, or "notetaker screenshots"> → [<date>-screen-timeline.md](<date>-screen-timeline.md)`.

## Canonical vocabulary — persist to CONCEPTS.md when it exists

Meetings are where domain vocabulary is born, renamed, locked, or retired. Every meeting decision that **establishes, renames, locks, or deprecates a canonical term** is highlighted in the summary. If the repo has a `CONCEPTS.md`, it is also **persisted to `CONCEPTS.md` in the same change** — never left only in the summary.

- **Highlight in the summary:** surface these under a dedicated `## Vocabulary decisions` block (and in the TL;DR when they're headline). Each: the term, what changed (new / renamed-from / **locked** / deprecated), and attribution.
- **Persist to CONCEPTS.md:** add or update the entry in the file's existing format. Record retired synonyms with the file's convention, or an `_Avoid:_ <old term>` line when it has none. When an existing entry already names the same thing under another word, rename or refine that entry rather than adding a near-duplicate. A term that's decided-but-not-fully-specified gets a provisional entry (note what's still being specified) rather than being omitted; drop the provisional hedge once a later meeting **locks** it. Cite the source meeting notes in the entry.
- **Scope:** domain entities, named processes, roles, status concepts, and customer-facing labels — not file/class/function names or implementation choices. `CONCEPTS.md` is a glossary.
- **No `CONCEPTS.md`:** keep the Vocabulary decisions block in the summary and do not create the file.

## PRFAQ handoff

Before writing the summary's closing section, scan `docs/prfaqs/README.md` (if present) **and** glob `docs/prfaqs/*-prfaq.md` (catches unregistered docs). Split what the meeting produced, per [references/prfaq-promotion-bar.md](./references/prfaq-promotion-bar.md):

- **Refinements to existing PRFAQs** — the meeting re-debated a topic that already has a PRFAQ. Offer a `<date>-prfaq-refinements.md` side artifact in the shape below. Don't pitch a duplicate PRFAQ.
- **Net-new candidates** — only initiatives that clear the promotion bar (**big/major AND cross-team AND genuinely debated in the transcript**). Small items fold into existing PRFAQs as dependencies. Name each candidate and offer to run the `ko-prfaq` skill — never auto-generate.

If the `ko-prfaq` skill isn't installed, still write the closing section (and the refinements file when offered and accepted), then print one install line: `npx skills add kevinold/skills -s ko-prfaq`.

### Refinements file shape

`ko-prfaq` consumes this file in its update mode, so keep the shape exact:

```markdown
# PRFAQ refinements — <Series> (<YYYY-MM-DD>)

Source: [<date>-summary.md](<date>-summary.md)

## <prfaq-file-name>-prfaq.md

- **Claim changes:** <what the PRFAQ now says differently> (Name, ~M:SS)
- **Status deltas:**
  - <capability> — <old status> → <new status or "re-check">
- **New open questions:** <question> (Name, ~M:SS)
- **Resolved open questions:** <question> — <landing point> (Name, ~M:SS)
```

One `##` section per affected PRFAQ, named by its exact filename; one nested bullet per capability under Status deltas. Omit empty bullets.

## Workflow

1. Locate the input doc (or enter backfill / video-pass-only mode); resolve series and date; confirm any fuzzy match.
2. Create the date dir; `mv` + rename the docx; extract and gate the transcript; write the transcript `.md`. File the tool auto-summary if one came with it.
3. Ask about chat-shared side files; file and note them.
4. Read `references/summary-spec.md` in full, read the transcript in full, then write `<date>-summary.md` — including a `## Vocabulary decisions` block when the meeting decided any canonical term.
5. If a recording or screenshots were supplied, run the video pass (`references/video-pass.md`).
6. Run the attribution verification pass over the summary and timeline — zero misses.
7. If `CONCEPTS.md` exists, persist canonical-vocabulary decisions to it in the same change.
8. Scan + glob `docs/prfaqs/`; write the closing refinements-vs-candidates split; offer the `ko-prfaq` skill for candidates and refinements.
9. Before offering a commit, confirm no recording or file over 5 MB is staged. Offer (don't auto-run) a `docs:` commit, following the project's own branch/PR conventions. Include the `CONCEPTS.md` change in that commit.
