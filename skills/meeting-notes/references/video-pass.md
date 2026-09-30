# Video pass — screen-share timeline from the recording

The transcript says what people said. The recording shows what they were looking at: the diagram someone drew, the settings page someone walked through, the prototype everyone reacted to. This pass turns that into `<date>-screen-timeline.md` and commits a small set of frames — only those that clear the PII gate.

Run it after the summary and before the PRFAQ handoff (SKILL.md workflow step 5), or on its own for an already-filed meeting (entry mode 4).

## Inputs

| Input | Needs `watch`? | Path |
|---|---|---|
| Local recording (`.mp4`, `.mov`, `.webm`, `.mkv`) | yes | **Recording pass** |
| Recording URL | yes | **Recording pass** — one attempt; if it needs a login or fails to download, ask the user for a local file |
| Notetaker screenshots (image files, or frames a notetaker exports or serves) | no | **Screenshot pass** |
| Nothing | — | Skip this file entirely |

**Never move, copy, or commit a recording.** Reference it by basename only — no absolute paths, no `file://` URLs, no home directories.

## Locate `watch`

`watch` is the external [bradautomates/claude-video](https://github.com/bradautomates/claude-video) skill. Find its directory (`SKILL_DIR`) in this order:

1. The harness's skill loader, when it can load `watch` by name — `SKILL_DIR` is the directory of the `SKILL.md` it loaded.
2. Otherwise, the first `SKILL.md` that has a sibling `scripts/watch.py` under one of: `~/.claude/plugins/cache/*/watch/*/skills/watch`, `~/.claude/skills/watch`, `~/.agents/skills/watch`, `~/.codex/skills/watch`, `./.claude/skills/watch`, `./.agents/skills/watch`.
3. No hit → `watch` is missing. Skip the recording pass and print the install line from SKILL.md's **Video pass** section. The transcript and summary are still filed.

Then run its preflight: `python3 "$SKILL_DIR/scripts/setup.py" --check`. Exit `0` or `3` (no Whisper key) → proceed. Exit `2` or `4` (missing `ffmpeg`/`ffprobe`/`yt-dlp`) → skip the recording pass and tell the user to run `python3 "$SKILL_DIR/scripts/setup.py"`.

## Recording pass

Sample at fixed times, not by scene detection: a screen share is often a static page, which scene and keyframe selection skip. Every `watch` call in this pass has the same shape:

```bash
python3 "$SKILL_DIR/scripts/watch.py" "<recording or downloaded file>" \
  --detail transcript --timestamps <t1,t2,…> --max-frames <number of timestamps> \
  --no-whisper --out-dir <tmp>/pass-NN
```

- **`--detail transcript --timestamps`** grabs exactly the listed moments (`watch` calls them cue frames, `cue_NNNN.jpg`) and skips scene sampling.
- **`--no-whisper`, always.** The transcript already exists. Without the flag, `watch` may upload the meeting audio to a transcription API when a recording has no captions — which a local recording never does.
- **`--max-frames`** set to the timestamp count, so the user's `watch` defaults can't change the budget.
- **Its own `--out-dir`.** Make one temp parent directory outside the repo (`mktemp -d`), and give each call its own subdirectory (`pass-00`, `pass-01`, …). `watch` clears earlier frames in an out-dir on every run, so a shared one keeps only the last call.

Delete the temp parent when the pass ends, whether it succeeded or failed. If any `watch` call fails, stop the recording pass there: delete the temp parent, report the error in one line, and finish the rest of the workflow — the transcript and summary still stand.

### 1. Scan

Get the duration from `ffprobe`, or from the notetaker summary's recording length. Scan timestamps are every 60 s, **plus** every moment the transcript flags a share ("sharing my screen", "can you see this", "let me show you", "look at this"), 10 s before and 10 s after. A share shorter than a minute is only caught by those cues.

Transcript times and recording times often differ. Shift each cue by the offset from the timeline's **Clock** line: the notetaker's recording start, or the first frame showing a speaker who opens the transcript. When the offset is unknown, widen each cue to 30 s before and after.

Read every frame. Mark the **share windows** — spans where a screen, not just camera tiles, fills the frame. For a URL, the scan's download lands under `<tmp>/pass-00/download/`; every later call reads that local file, never the URL again.

### 2. Budget

For each window, plan one frame every 20 s. Add them up with the scan. If the total exceeds **150 frames**, show the per-window counts and ask before running — the user can raise the ceiling, drop windows, or thin the sampling.

### 3. Focused passes

One call per window with timestamps every 20 s across it, at `watch`'s default 512px width.

Read every frame. Where small text matters — a row's content, or deciding whether a frame is safe to commit — re-grab just those moments with `--resolution 1024` in a fresh `pass-NN`. A frame approved for commit is copied from its 1024px re-grab when one exists.

`watch` prints each frame's `t=MM:SS` or `t=H:MM:SS`. Record those timestamps; committed frames are named from them (`HH-MM-SS.jpg`), not from the sequence number.

## Screenshot pass

Order the screenshots by their timestamps (filename, EXIF, or the notetaker's metadata). Screenshots with no timestamp keep the order they arrived in, and their rows say **time unknown**. Notetaker capture roles ("hero", "filmstrip", and the like) say why a frame was captured, not what it shows — every frame may still show a shared screen. A committed screenshot keeps its file type and is named `<HH-MM-SS>.<ext>` when its time is known, or `shot-<n>.<ext>` in arrival order when it isn't. Then continue with the timeline and PII gate as below.

## Write the timeline

`<date>-screen-timeline.md`:

```markdown
# <Series> <YYYY-MM-DD> — screen-share timeline

**Source:** `<recording basename>` (<resolution>, <duration>) — not copied into the repo. *or* Notetaker screenshots (<count>).

**Method:** <scan + focused passes, frame counts, resolution, anything re-grabbed> *or* <screenshots, how ordered>.

**PII redaction.** Third-party customer names, personal names, production records, emails and local paths are generalized in this file, and frames showing them are not committed. <What was generalized, in one line.>

**Sharers:** <one bullet per share window — who shared and the on-screen evidence: account avatar, browser theme or profile, share banner, file paths. "(inferred)" when the evidence is indirect.>

**Clock:** <recording time vs transcript time offset, e.g. "recording 00:00 = transcript 0:42", or "unverified">. Times below are recording elapsed time.

**Chapters** from <the notetaker summary or the meeting summary's threads> label the sections below.

## Timeline

| Time | Sharer | Surface | What's visible | Committed |
|---|---|---|---|---|
| **00:00–09:12 · <chapter>** | | | | |
| 00:00:20–00:01:00 | <name or "—"> | <app / page, generic> | <what's on screen, generic> | no (camera tiles only) |
| 00:14:20 | <name> | <app / page> | <what's on screen> | [00-14-20](assets/video-frames/00-14-20.jpg) |
```

- One row per distinct screen. Collapse identical consecutive frames into one row with a time range; a collapsed row doesn't prove nothing changed between samples, so say "sampled every Ns" in Method.
- **Committed** is a link to the committed frame, or `no (<reason>)`.
- Optional `## Surfaces seen` table at the end: each app or page, who showed it, and when.
- Attributions in the table (who said what while a screen was up) follow the summary's `(Name, ~M:SS)` rule and are checked in the attribution pass.

## PII gate

Nothing reaches `assets/` until this gate passes. It covers the **row text** and the **frames**.

**Row text** — write every row generically. No row may carry:

- third-party customer, client, or company names (the team's own org and publicly named vendors are fine)
- personal names of people outside the meeting
- production record names, IDs, amounts, or contacts (CRM deals, orders, tickets, database rows)
- emails, phone numbers, or street addresses
- absolute local paths, `file://` URLs, or internal hostnames

Describe instead: "a customer deal record in the production CRM (name redacted)".

**Frames** — propose a frame for commit only when it shows one of:

- a diagram or whiteboard the team drew
- a public page (vendor docs, a public website)
- dev, test, or clearly fictional seed data

Reject any frame that also shows, even in a corner: a bookmarks bar or tab titles naming clients, a notetaker's recording list, an inbox or chat sidebar, account avatars or emails, a terminal prompt with a username or hostname, or a production record. When unsure, reject — the row text still carries what was on screen.

**Approval — once, as a whole.** Show the user the proposed frame list: timestamp, one-line description, and why it's safe. The user approves, trims, or rejects the list in one answer. Only then copy the approved frames into `assets/video-frames/` (named per the recording or screenshot pass above), and set every other row's Committed cell to `no (<reason>)`.

**After copying**, check that every `assets/video-frames/` link in the timeline and summary points at a file that exists, and that no frame in `assets/video-frames/` goes unlinked.

## Link it up

Add one line to the summary's metadata block:

`**Recording + screen timeline:** <recording basename, or "notetaker screenshots"> → [<date>-screen-timeline.md](<date>-screen-timeline.md)`

In **video-pass-only** mode (the meeting was already filed), that line and the new files are the only changes. Do not regenerate the summary, change its H2 headings, or delete frames a committed doc links to. A second recording or screenshot set for a date that already has a timeline gets `<date>-screen-timeline-2.md` (then `-3`, …), its own metadata line, and its own frame folder `assets/video-frames-2/` (then `-3`, …). Never overwrite an existing file in `assets/`.

## Finish

- The temp parent directory is gone.
- No recording and no file over 5 MB is staged.
- The attribution pass (SKILL.md workflow step 6) covered the timeline too.
