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
