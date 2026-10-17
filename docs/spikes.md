# Phase 0 spikes (2026-10-11, Apple M2 MacBook Air 16 GB, ffmpeg 8.1.1, HyperFrames 0.8.134)

Scripts live in `spikes/`; their output goes to `spikes/out/` (gitignored).

## (a) Transcription bake-off — `spikes/transcribe-bakeoff.sh`

3-minute excerpt (60–240 s) of a real take, `~/Downloads/Untitled video - 30 Sept 2026.mp4`.

| Engine | Wall time | Words | Filler tokens kept | Gaps ≥ 250 ms | Notes |
|---|---|---|---|---|---|
| whisper small.en | 537 s* | 377 | 0 | 40 | *includes the one-time whisper.cpp compile |
| whisper medium.en | 51 s* | 356 | 0 | 48 | *includes the 1.5 GB model download |
| whisper large-v3 | 112 s | 471 | 0 | 34 | no repetition hallucinations found |
| **parakeet (default)** | **10 s** | 407 | **22** | 22 | verbatim: keeps "uh" and repeats ("every every page"), no punctuation |
| OpenAI whisper-1 | — | — | — | — | skipped: no `OPENAI_API_KEY` |

Same 60–75 s window:

- whisper medium.en: "…and then also have searchable text for every page, which is split at its headings into about 1,300"
- parakeet: "…and then i also have searchable text for every every page which is split at its headings uh into about 1300 different or so uh about"

**Decision:** default `transcription.localEngine = "parakeet"`. Every Whisper size silently drops ums *and* repeated words. Those are exactly what the editor needs to find and cut. Whisper stays selectable, and voiced-gap detection still catches what any engine drops. Captions use the script's spelling where a word matched the script, so Parakeet's missing punctuation doesn't reach the viewer.

## (b) Headless Claude — `claude -p --json-schema --output-format stream-json`

- **Blocked on login.** The CLI has no saved login: `claude auth status` → `loggedIn: false`, even with a clean environment. Fix: run `claude auth login` once in a terminal.
- **The runner strips inherited host-session variables** (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `ANTHROPIC_BASE_URL`; see `cleanClaudeEnv` in `src/claude/runner.ts`). This makes the child use the user's own terminal login even when the server is started from inside the desktop app.
- **Structured output field:** confirmed by reading the installed CLI (2.1.261). The `result` event carries `structured_output` when `--json-schema` is set. The runner also falls back to parsing JSON out of the reply text.
- **Tool allow-list:** `--allowedTools Read` is enough for the edit plan; the internal StructuredOutput tool approves itself. Live confirmation is still pending the login.

## (c) Transparent HyperFrames overlay — `spikes/hf-overlay/`

- `hyperframes render --format mov` → ProRes 4444, `yuva444p12le`, 2560×1440, 5 s in **21 s** (≈4× real time).
- `ffmpeg … overlay=0:0:eof_action=pass:format=auto` composites it cleanly over the yuv444p source.
- `hyperframes validate` is deprecated in 0.8.x; use `hyperframes check`.

## (d) Frame-accurate segments and A/V sync — `spikes/segment-sync.mjs`

| Run | Segments | Frames expected / got | A/V drift | Frame accuracy | Encode time |
|---|---|---|---|---|---|
| 720p preview profile | 200 (210.5 s kept) | 6316 / 6316 | 0 ms | best PSNR at offset 0 for all checked segments | 108 s |
| 1440p final profile | 30 (32.8 s kept) | 985 / 985 | 0 ms | offset 0 | 26 s (≈0.8× real time) |

Video segments are cut with `-ss` before `-i`, `-frames:v N` and `h264_videotoolbox`, then concatenated with the concat demuxer (`-c copy`). Audio pieces are cut sample-exactly from a 48 kHz PCM wav with a 30 ms `afade` at each end, then concatenated as PCM.

## (e) Burned-in captions

This Homebrew ffmpeg has **no libass and no drawtext** (no `subtitles`/`ass` filters). X-clip captions are therefore rendered as a transparent HyperFrames caption layer and overlaid, which was the plan's fallback.

## (f) The Claude-driven steps, run for real (2026-10-11)

The `claude` CLI on this Mac isn't logged in yet, so `claude -p` itself couldn't run. Every step was split into
`prepare → Claude → apply` (`preparePlan/applyPlan`, `prepareGraphic/validateGraphic/finishGraphic`,
`prepareXClips/applyXClips`). Opus subagents then did the Claude part. Each was given exactly what the headless
run receives: the same system prompt file, user prompt, input files, JSON schema and allowed tools. Each answer
went through the real validation, compilation, rendering and stage code (`scripts/claude-steps.ts`). The only
link not exercised is the CLI's own authentication.

Project `live-claude-check`, the fixture take created through the server API:

- **Import, transcription, alignment.** Real Parakeet, through the server: 307 words, 22/23 lines matched,
  1 missing line, 1 retake, 2 ad-libs.
- **Plan edit.** Passed schema validation first time and compiled with 0 warnings.
  - Takes: kept the clean retake.
  - Ad-libs: cut "let me redo that" and kept the good one.
  - Cuts: 3 filler words.
  - Graphics: all 3 anchored to where their topic is first spoken.
  - Notes: flagged the missing line (needs a pickup recording) and noticed "Cloed" = "Claude".
- **Graphics.** g1 (job cards), g2 (model/engineer/product stack) and g3 (essay card): on brand, in the open-side
  zone, passed lint and check, and rendered ProRes 4444 at the exact length (19.63 s, 23.50 s, 13.70 s).
- **Render.** 1:43 final with 3 graphics, intro, and an end card with the next video's title.
- **X clips.** Picked 35.5 s and 40.6 s moments within the rules, rendered at 1080p with brand captions.

Bugs this run found (all fixed, with regression tests):

1. **Clipped word onsets.** Frame snapping rounded a segment start past the next word's onset after a filler cut
   ("chasing" lost its "ch"). Snapping now always widens.
2. **Mishearings in captions.** Script spelling only fixed exact matches, so "Cloed"/"min set" would have been
   burned into captions. Clean substitutions between matched neighbours now take the script's spelling.
3. **Brief vs brand.** The planner's briefs asked for pulsing and flashing, which BRAND.md forbids. Both prompts
   now say the brand's motion rules win, and the brief decides content and timing.
4. **Needless rebuilds.** A graphic shifting by a frame or two marked it stale and asked for a Claude rebuild.
   Duration now only marks it stale beyond 0.25 s.

## (g) Live run with the real `claude -p` (2026-10-11, after `claude auth login`; Max plan)

New project `live-cli-check` (the fixture take, **centered** framing). Every stage was started from the UI's
buttons on the production server. Model: claude-opus-5.

| Step | Real result | Time | Cost* | Permission denials |
|---|---|---|---|---|
| Plan edit | 22 take groups, 8 cuts, 3 graphics, 0 warnings. g1 = **split** across both sides; g2 right, g3 left (alternating) | 156 s | $0.59 | 0 |
| Graphics g1 / g2 / g3 | All three passed server lint/check **first time** (no fix-up round). Split cards on both sides, sides respected | 100 / 70 / 73 s (+ render) | $0.56 / $0.39 / $0.40 | 0 |
| Render | 1:43 final with 3 graphics, intro and end card | ~30 s | — | — |
| X clips | 2 clips (35.5 s, 44.5 s), captions burned in, clip 2 ends exactly where the end card starts | 49 s + render | $0.14 | 0 |

*`total_cost_usd` as the CLI reports it. On a Max subscription this counts against plan usage, not billed per token.

**Security finding, fixed before this run:** on its own, `--allowedTools` only pre-approves tools. A live
probe with just `Read` allowed still ran Bash. Every run now passes `--tools` (only the allow-list's tools
exist), `--permission-mode dontAsk` and `--restricted`. Graphics runs no longer get a shell.
Verified live: Bash is absent for read-only runs, and a write outside the one allowed file is denied.

## (h) Cut quality on Hamza's real voice (2026-10-11)

No script-read recording existed yet, so the test used a 3-minute excerpt of a real, unscripted take
(`Untitled video - 30 Sept 2026.mp4`, 60–240 s). A matching script was written from what he actually said,
with fillers removed, plus three graphic cues. Everything stayed in the gitignored `projects/` folder.
The excerpt went through the full pipeline, including a real `claude -p` plan
($0.93; 44 cuts: 31 fillers, 3 false starts, 3 repeats, 3 of 7 ad-libs).

**Measurement:** `spikes/roundtrip.ts` re-transcribes the *edited* audio and compares it with the words the
edit meant to keep.

| Version | Edited length | Word error vs intended | Kept words with a clipped onset | um/uh still audible |
|---|---|---|---|---|
| Claude's plan, filler cuts at ASR word stamps | 145.7 s | 3.0 % | 0 | **10** |
| + filler edges snapped to energy valleys, + listen-back sweep | 143.5 s | 3.6 % | 0 | **4** |

The word-error figures are Parakeet's own variation ("eval"/"evals", "Claude"/"cloud"); no words were lost.

**Why ums survived, and the fixes:**
1. **Coarse ASR timing.** Parakeet's word stamps are coarse (~80 ms), so cutting exactly at them left the
   edges of an "uh". Fix: filler words, and their neighbours' boundaries, now snap to the quietest 10 ms
   nearby (`src/media/energy.ts`, `src/transcribe/refine.ts`).
2. **Fillers missing from the first transcript.** The first pass folded some fillers into a neighbouring word
   ("question." stamped across 0.96 s). Fix: after Claude's plan, the preview is re-transcribed, and each
   um/uh still heard is mapped back to the source and cut. The sweep never takes a kept word, never overrules
   a kept filler or a cut the user made, and makes up to 2 passes (`src/transcribe/sweep.ts`).

**The 4 that remain:** in three, the "uh" runs straight into the next word, and cutting further would clip
that word, which the sweep correctly refuses. The fourth falls where a cut join makes its position ambiguous.
These are short fragments, not whole ums. Removing them would need a crossfade or a pickup line, not a
harder cut. **A listening check by Hamza on his own material is still the real judge.**

### (h, round 2) After Hamza listened (2026-10-17)

He reported that some cuts were very noticeable and asked why a huge pause was kept. `spikes/diagnose-cut.ts`
(long silences in the edited audio, mapped back to the source, plus a profile of every join) found two causes:

1. **The huge pause.** Parakeet stamped the word "team." as lasting **17.6 s**, because it attached a silence
   (him going quiet during the demo) to the last word. The editor treats a word's span as speech, so all 17 s
   were kept. Smaller cases: "pages," (1.2 s) and "happen." (1.28 s). Fix: word stamps are trimmed so they never
   cover a detected silence of 0.25 s or more (`src/transcribe/speech.ts`). The pause cap then shortens the real
   gap.
2. **Words butting together.** 22 of 36 joins had under 120 ms between the words on either side. The earlier
   filler fix snapped cut edges out to the quietest point up to 160 ms away, which also removed the natural
   pauses around each "uh". Fix: cut only the *voiced* part of the filler, plus 30 ms either side
   (`voicedCore` in `src/media/energy.ts`), so the surrounding pauses stay.

| | Round 1 | Round 2 |
|---|---|---|
| Edited length (from 3:00) | 2:23 | 2:00 |
| Silences ≥ 0.55 s in the edit | 14 (one 17 s) | 1 (0.73 s, a paragraph change) |
| Joins under 120 ms between words | 22 of 36 | 13 of 43 (median 0.15 s) |
| um/uh still audible | 4 | 3 |
| Kept words clipped | 0 | 0 |
