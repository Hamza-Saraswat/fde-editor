# fde-editor: script-aware video editor for the FDE channel

## Context

Hamza publishes one long-form talking-head YouTube video a week (FDE / AI-engineering channel; source of truth is the Eden board). Each video starts as a markdown script with `**SAY**` blocks, `> GFX:` cues (HyperFrames motion graphics) and `> B-ROLL:` cues (job-post and recruiter screenshots popping in on the open side of frame). Today the raw takes get cut by hand in CapCut. He wants a local tool where he drops in the recording and the script, and then:

1. Claude Code (Opus, on his own login, no Anthropic API key) matches the recording to the script, picks the best take of each line, and removes ums, uhs, stumbles and dead air.
2. Claude builds each motion graphic in HyperFrames, sized to the exact moment the line is spoken.
3. He reviews everything in a UI: undo any cut, swap takes, nudge graphics.
4. It renders the finished MP4 with an intro and outro, plus YouTube chapters, an SRT captions file, and 2–3 clips for X.

Transcription (audio to words with timestamps, the one thing Claude can't do from text) has two engines behind one setting:

- **Local Whisper on the Mac** via `hyperframes transcribe`. No key, and audio never leaves the machine.
- **OpenAI `whisper-1` API.** Needs a key, about 6¢ per 10 minutes.

A Phase 0 comparison on his real footage picks the default. If local is good enough, no key is ever needed. Nothing else uses OpenAI.

## Locked decisions

| Topic | Decision |
|---|---|
| Delivery | Mostly scripted with some ad-libs. Alignment is fuzzy, and Claude judges the ad-libs. |
| Footage | One long take or several clips, plus screenshots and screen clips used as overlays. |
| Output | Finished MP4 at the source resolution (2560×1440, 30 fps). No export to Resolve in v1. |
| Claude trigger | A button in the UI runs headless `claude -p --model opus` on his login. |
| Transcription | Both engines, local and OpenAI `whisper-1`, normalized to the same word format. A dropdown on the Transcribe step chooses the engine. The default lives in `fde-editor.config.json` and is set by the Phase 0 comparison; until then it is local. Filler detection from audio gaps runs no matter which engine is used. |
| Graphics | Claude writes HyperFrames compositions after alignment, timed to the spoken words. They are rendered transparent and laid over the footage. |
| Review | Every cut and graphic is visible. He can toggle cuts, swap takes and nudge graphics before rendering. |
| Bad takes | Claude picks the best take, and the other takes can be swapped in from the UI. |
| Architecture | A local web app. ffmpeg cuts and renders; HyperFrames renders only the graphic clips. |
| Brand | A new channel brand pack, built in phase 6. Claude produces 3 directions, he picks one (a single pause), and it gets locked. |
| Extras | YouTube chapters, captions file (SRT), X clips, and loudness at −14 LUFS (always on). |
| Repo | `https://github.com/Hamza-Saraswat/fde-editor.git` exists and is empty (checked 2026-10-11 with `git ls-remote`). Clone it to `~/Documents/Projects/fde-editor`. The **active `gh` account is the work account `hamza-saraswat-fp`**, so run `gh auth switch --user Hamzas-Aigentic` and set the repo-local git `user.email` to the personal address before the first commit or push. |

## Verified research this plan relies on (2026-10-11)

- **HyperFrames** (heygen-com/hyperframes)
  - Apache-2.0, about 61k stars, 2.4M npm downloads a month, listed in Anthropic's official plugin marketplace.
  - `render --format mov` produces ProRes 4444 with alpha. `data-media-start` sets an offset into a video. `lint`, `validate` and `snapshot` check a composition.
  - It can import an OpenAI `whisper-1` `verbose_json` transcript.
  - Telemetry is on by default; turn it off with `HYPERFRAMES_NO_TELEMETRY=1`.
- **Local transcription:**
  - `hyperframes transcribe <audio> --json --model <m>` runs a bundled whisper.cpp locally, or Parakeet if it's installed. Force an engine with `--engine whisper`.
  - Models: tiny, base, small, medium, large-v3, plus `.en` English-only variants. Always pass `--model`.
  - It writes the flat word array `[{id,text,start,end}]`.
  - The same command also normalizes an OpenAI `whisper-1` `verbose_json` response (`hyperframes transcribe openai.json`), so both engines produce the exact same format.
  - whisper.cpp marks word-level timestamps as "experimental". Both engines are Whisper-family and drop fillers similarly.
- **OpenAI `whisper-1`** is the only OpenAI model with word timestamps (`verbose_json` plus `timestamp_granularities[]=word`).
  - Limit is 25 MB per file. A mono 64 kbps file is about 0.48 MB a minute, so up to about 50 minutes fits in one request.
  - Costs $0.006 a minute.
  - A prompt containing fillers *may* keep ums in the transcript, but this is unproven. So we also detect fillers from the audio.
- **ffmpeg 8.1.1** with VideoToolbox:
  - `-ss` before the input gives frame-accurate cuts when re-encoding.
  - The concat demuxer copies segments without re-encoding.
  - VP9 alpha needs `-c:v libvpx-vp9` placed before `-i` (tested locally).
- **Claude Code 2.1.261:** `-p`, `--output-format stream-json`, `--json-schema`, `--allowedTools`, `--append-system-prompt-file`, `--model`.
- **Design references we borrow ideas from (no dependency):**
  - browser-use/video-use (MIT): Claude writes an EDL, ffmpeg renders it with 30 ms fades.
  - The HyperFrames `talking-head-recut` card system.
- **Rejected:**
  - CrisperWhisper: the weights are non-commercial only.
  - Remotion Editor Starter: $600 and built for React.
  - OpenMontage: AGPL.
  - Descript and Kapwing MCPs: cloud only.
  - Rendering the whole video in HyperFrames: on his M2 Air this is about 3.5× slower than real time.

## Machine facts

- Apple M2 MacBook Air, 16 GB, macOS 14.
- ffmpeg 8.1.1 with `h264_videotoolbox`, `hevc_videotoolbox` and `prores_videotoolbox`.
- Node 22.23, pnpm, uv (Python 3.12), gh.
- Raw takes are H.264 High 4:4:4, yuv444p, 2560×1440, 30 fps constant, AAC (example: `~/Downloads/Untitled video - 30 Sept 2026.mp4`).
- Screen recordings from Screenity are variable frame rate and need conforming to 30 fps.
- `OPENAI_API_KEY` is not set, and is **optional**: only the OpenAI engine needs it. If he wants that engine, he puts the key in `fde-editor/.env` himself.
- **Local Whisper status:**
  - No HyperFrames Whisper model is cached yet (`~/.cache/hyperframes` has only chrome and fonts), so the first local run downloads the model: about 0.5 GB for small, 1.5 GB for medium, 3.1 GB for large-v3.
  - A separate whisper.cpp v1.7.4 build with `ggml-base.en.bin` exists in `BLAI_Animator/render/remotion/whisper.cpp/`. It's not needed, but it's a fallback.

## Architecture

```
Browser UI (Vite + React + Tailwind v4)
   │  REST + SSE (job progress)
Node server (Hono, TypeScript)
   ├─ core/       schemas (zod), script parser, aligner, edit compiler, timeline map
   ├─ media/      ffprobe, proxy, audio extract, silencedetect, segment cache, render
   ├─ transcribe/ Transcriber interface, two engines → same words:
   │              local (`hyperframes transcribe`) | openai (whisper-1 via fetch, no SDK)
   ├─ claude/     headless runner: spawns `claude -p`, streams events, validates JSON
   └─ graphics/   HyperFrames lint/validate/snapshot/render queue, mov→webm preview
projects/<slug>/  (gitignored) everything for one video, stored as plain JSON files
```

Single TypeScript package (pnpm), with execa for child processes and vitest for tests. There is no database: each project folder is the state, and the server can restart and pick up where it left off.

### Project folder (`projects/<slug>/`)
```
script.md            copied from FDE_Channel/<video>/youtube-script.md (re-sync button)
script.json          parsed: sections → sentences (ids s3.2) → cues (gfx|broll|optional, anchor)
media/               symlinks to raw clips + screenshots;  proxy/ 720p yuv420p -g 30 previews
audio/               per-clip 16 kHz mono mp3 (whisper) + 48 kHz WAV (render)
transcript.json      words [{id, clipId, text, start, end}] + silences + filler candidates + {engine, model}
transcripts/         raw output per engine+model (e.g. local-medium.en.json, openai-whisper-1.json) so switching engines never re-bills or re-runs
candidates.json      aligner output: per-sentence take candidates, ad-lib spans, missing lines
plan.json            Claude's validated edit decisions (raw)
edit.json            source of truth the UI edits (see below)
graphics/<cueId>/    index.html (HyperFrames), render.mov (ProRes 4444), preview.webm, still.png
cache/segments/      content-hashed video segments + PCM audio pieces
runs/                logs for every claude / ffmpeg / hyperframes job
out/                 final.mp4, chapters.txt, captions.srt, x-clips/*.mp4
```

### `edit.json` (one representation drives everything)
- **`cuts[]`**: source-time ranges `{id, clipId, start, end, reason: filler|silence|stumble|alternate-take|adlib|user, by: auto|claude|user, enabled}`. Kept footage is every clip minus the enabled cuts.
- **`takeGroups[]`**: `{sentenceIds, options:[{clipId,start,end,score}], chosen, why}`. Choosing an option re-enables `alternate-take` cuts on the other options.
- **`clipOrder[]`**: the order of clips in the edit, following the script.
- **`overlays[]`**: `{cueId, anchorWordId, endWordId, offsetMs, durMs?, layout: side|full, side: left|right, assetIds[], status}`.
  - Anchors are stored as **word IDs**, not times, so graphics follow the words when cuts change.
  - A nudge is stored as `offsetMs`.
- **`chapters[]`** are anchored to the first sentence of each script section.
- **`intro`** and **`outro`** are brand-pack renders. The end card takes `--variables` such as the next video's title.
- **Derived (not stored):** the keep segments (snapped to frame boundaries, with configurable padding of 80 ms before and 120 ms after, and pauses capped at 400 ms), and a timeline map from source time to output time that gives overlay, chapter and caption times.

## Pipeline

1. **Import**
   - ffprobe every file and flag HDR (refuse it, with an instruction to record in SDR) and variable frame rate (conform to 30 fps).
   - Make the 720p proxies with VideoToolbox.
   - Extract the audio.
   - Parse the script with a deterministic parser matched to his format: `## section`, `**SAY**` paragraphs split into sentences, and `> GFX:` / `> GFX (OPTIONAL)` / `> B-ROLL:` cues. A cue anchors to the end of the previous SAY block, or to a quoted phrase ("when you say 'cheat sheet'"). `[CONFIRM…]` / `[VERIFY…]` flags are stripped. The Description and "Before you record" sections are skipped.
2. **Transcribe** (engine picked by dropdown; the default comes from config)
   - **Local:** `HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes transcribe audio/<clip>.wav --json --engine whisper --model <localModel> --language en`. The default model is whichever wins Phase 0.
   - **OpenAI:**
     - POST each clip's mono mp3 to `/v1/audio/transcriptions` with `model=whisper-1`, `response_format=verbose_json`, and word plus segment timestamps.
     - The prompt is a filler-laden sentence plus proper nouns from the script, under 224 tokens.
     - Over 24 MB, chunk at a silence and offset the timestamps.
     - Normalize the response through `hyperframes transcribe <response>.json`.
     - Fails clearly in the UI when the key is missing.
   - Both engines save raw output to `transcripts/`, then write the shared `transcript.json` with word IDs and the clip offset. Everything after this step is engine-agnostic.
   - Run `silencedetect` with an adaptive threshold, using the loudnorm `input_thresh` rule from the BLAI `remotion-best-practices/rules/silence-detection.md` file.
   - **Filler candidates:** any gap between words that is over 250 ms and contains no silence (so it has voice) is probably an "um" Whisper dropped. Plus any filler tokens Whisper did transcribe.
3. **Align (deterministic)**
   - Normalize the words: numbers spelled out, hyphens joined, acronyms collapsed.
   - Find every fuzzy occurrence of each script sentence in the transcript (difflib `SequenceMatcher(autojunk=False)` on word tokens, with a sliding window).
   - Take a monotonic best path through the script. Repeated occurrences become take candidates, unmatched transcript spans become ad-libs, and unmatched script lines are marked missing.
4. **Plan edit (Claude, button)**
   - `claude -p --model opus --output-format stream-json --verbose --json-schema schemas/edit-plan.json --append-system-prompt-file prompts/edit-plan.md --allowedTools Read`, run in the repo with the project paths passed in.
   - Claude reads `script.json`, `transcript.json` and `candidates.json`.
   - It returns the chosen take per sentence with its reason, keep or cut for each ad-lib, word-level cuts (fillers, stumbles, false starts), and for each cue: the anchor word, the end word, the layout (side or full) and a design brief.
   - The server validates the result with zod and compiles it into `edit.json`.
   - **Never `--dangerously-skip-permissions`.** Anything not on the allow-list is denied in `-p` mode (checked in Phase 0).
5. **Graphics (Claude, button, one cue at a time or all)**
   - For each cue: `claude -p --model opus` with the vendored HyperFrames skills and the locked brand pack, allowed only `Read`, plus `Write`/`Edit` scoped to `projects/<slug>/graphics/<cueId>/**`, plus `Bash(npx hyperframes lint|validate|snapshot:*)`.
   - Claude writes `index.html` with a transparent background, the output resolution, the exact duration (from the aligned words), and the open side of the frame.
   - The server then runs lint, validate and snapshot (the still for the UI), then `render --format mov`, then converts to a 720p VP9-alpha `preview.webm`.
   - Queue: one Claude run at a time and one render at a time (16 GB RAM).
   - "Regenerate with note" re-runs Claude with his feedback appended.
   - **B-roll:** he attaches a screenshot to a cue in the UI and draws crop, blur and highlight boxes. These are required for job posts (identifying lines are cropped). Claude builds the card from the image and the boxes.
6. **Preview (fast, incremental)**
   - Each keep segment is encoded once at 720p (video only, frame-accurate `-ss`/`-t`, h264_videotoolbox, cached by content hash).
   - The audio is a PCM WAV piece with 30 ms `afade` in and out at each end.
   - Concat both with the concat demuxer and mux them into `preview.mp4`. Toggling a cut only re-encodes the segments that changed.
   - Graphics play as `<video>` (webm with alpha) laid over the player in the page, timed from the timeline map.
7. **Final render**
   - Build the same segment cache at full resolution (hevc_videotoolbox at high quality), then concat to make the A-roll.
   - One ffmpeg pass:
     - Overlay each ProRes 4444 graphic with `setpts` offset, `enable=between(t,a,b)` and `eof_action=pass`.
     - Concat the intro and outro.
     - Two-pass `loudnorm` to I=−14, TP=−1.5, LRA=11 (ported from BLAI `assemble.py`).
     - Encode to H.264 at bt709, `+faststart`.
   - Also writes `chapters.txt` (YouTube needs the first chapter at 0:00 and each chapter at least 10 s long) and `captions.srt` (transcript words mapped through the edit, using the script's spelling where a word matched the script).
8. **X clips (Claude, button)**
   - Claude picks 2–3 moments of 30–60 s from the *final* edit (schema: start and end in output time, a hook line, and a why).
   - Render them at 16:9 with burned-in captions: an ASS file in brand fonts via libass, checked in Phase 0. The fallback is HyperFrames' `embedded-captions` `anchor` style.
   - Writes `out/x-clips/`.

## UI (one review screen plus a project list)

- **Project list / new project:** pick the script (defaults to `~/Documents/Projects/FDE_Channel/*/youtube-script.md`), add clips and screenshots, and set which side of the frame he sits on.
- **Pipeline bar:** Import → Transcribe → Plan edit → Graphics → Render → X clips. Each step shows a status, live log over SSE, and can be cancelled or re-run.
  - Transcribe has an engine dropdown: "Local (no key)" or "OpenAI whisper-1", with a model picker for local.
  - Switching engines reuses any cached raw output.
- **Review screen:**
  - **Script pane:** each sentence shows as matched, ad-lib or missing, with a take picker (plays each take).
  - **Transcript pane:** words with cut spans struck through and colored by reason. Clicking a word or span toggles the cut.
  - **Player:** `preview.mp4` with the graphic overlays in the page.
  - **Timeline:** the footage segments, cut markers, and the graphics track. Drag a block to nudge it (writes `offsetMs`); drag its edges to set the duration.
  - **Inspector:** the selected cue's brief, the rendered still, a regenerate-with-note button, and screenshot attach with crop, blur and highlight boxes.
  - Undo and redo for all edits.
- **Output panel:** open the final video, copy chapters, reveal the SRT and the X clips.

## Reuse (port, with attribution in NOTICE.md)

- `BLAI_Full_Pipeline/skills/elevenlabs-narration/scripts/qa_transcribe.py`: `normalize_words()` (l.171–197), `align()` Levenshtein with backtrace (l.328–367), `mismatches_from_ops()` (l.370–388).
- `BLAI_Full_Pipeline/skills/elevenlabs-narration/scripts/captions.py`: `map_to_script()` difflib mapping (l.66–96), `build_cues()` / `write_srt()` (l.107–133).
- `BLAI_Full_Pipeline/skills/render-shorts/scripts/assemble.py`: `ffprobe()` (l.87–107), two-pass `measure_loudness()` / `loudnorm()` (l.196–213), and the bt709 note (l.381).
- `BLAI_Animator/skills/remotion-best-practices/rules/silence-detection.md`: the adaptive silence threshold.
- HyperFrames skills: vendor them with `npx skills add heygen-com/hyperframes` into `fde-editor/.claude/skills`, pinned by `skills-lock.json`. Pin the latest `hyperframes` npm version in `package.json` and bundle GSAP locally (no CDN).
- `talking-head-recut` `references/` (layouts, styles, frames) as card-design input for the brand pack.
- The pattern of `claude -p` with `--output-format json` from `BLAI_Full_Pipeline/build/stage_runner.py` (l.252–273), **minus** `--dangerously-skip-permissions`.

## Build phases (one session, run in order; subagents for independent work)

0. **Spikes and gates**, each result logged in `docs/spikes.md`:
   - (a) **Transcription bake-off** on 3 minutes of a real take (`~/Downloads/Untitled video - 30 Sept 2026.mp4`, or his test recording once it exists):
     - Engines: local `small.en`, local `medium.en`, local `large-v3`, and `whisper-1` with and without the filler prompt. Skip the OpenAI rows if no key has been added.
     - Measure:
       - Wall-clock time on the M2.
       - Word errors against a hand-checked 60-second excerpt.
       - Word-boundary accuracy: spot-check 20 cut points by ear.
       - Fillers kept, and how many of the dropped ones gap detection catches.
     - Write a table to `docs/spikes.md` and set the default engine and model in `fde-editor.config.json`.
   - (b) `claude -p --json-schema` with `stream-json` returns validated structured output on his login, and tools not on the allow-list are denied. Fallback: `--output-format json` plus zod parsing.
   - (c) Pinned HyperFrames renders a 5 s 2560×1440 transparent mov, and ffmpeg overlays it correctly.
   - (d) 200 frame-accurate segments from a yuv444p source, concatenated, stay in A/V sync (drift under 1 frame).
   - (e) ffmpeg has libass.
   - **Gates (Hamza):** optionally, `OPENAI_API_KEY` in `.env` so the bake-off can include the API. Then `gh auth switch --user Hamzas-Aigentic` and confirm `gh auth status` shows the personal account as active.
1. **Scaffold:** clone the empty repo; pnpm and TypeScript, Hono server, Vite UI, vitest, zod schemas, the `projects/` gitignore, `.env.example`, vendored HyperFrames skills and pinned CLI, `NOTICE.md`, and the design doc saved to `docs/design.md`.
2. **Import and script parser:** probe, proxy, audio, and the parser, with tests against a copy of `FDE_Channel/01_what-is-an-ai-engineer/youtube-script.md`.
3. **Transcribe, detect and align:**
   - The `Transcriber` interface with local and OpenAI engines, the engine dropdown and config default, and the raw-output cache.
   - Silences, filler candidates, and the ported aligner.
   - Unit tests, including that both engines' fixture outputs normalize to the same shape.
4. **Claude runner and edit plan:** runner, schema, prompt, compiler, timeline map, and tests for frame snapping, padding, pause capping and the map.
5. **Renderer:** segment cache, preview, final render, loudnorm, chapters and SRT, with tests on the generated arguments plus an ffprobe check of the output.
6. **Brand pack and graphics:**
   - Claude generates 3 brand directions as HyperFrames stills. **Pause for Hamza to pick.**
   - Lock the tokens and templates in `brand/`: tokens.css, intro sting, end card with variables, lower-third, title card, stack, checklist, screenshot frame.
   - Then build the per-cue graphics job and queue, and the B-roll card with crop, blur and highlight boxes.
7. **UI:** project list, pipeline bar with SSE, review screen (four panes plus inspector), undo, output panel.
8. **X clips:** the Claude pick job plus rendering with burned-in captions.
9. **End to end and publish:**
   - Synthetic fixture test (below).
   - Real run on a test recording.
   - README.
   - Push to `Hamza-Saraswat/fde-editor`. Commit locally after each phase. Push only after the personal-account check, and confirm with Hamza before the first push.

## Verification

- **Unit tests (vitest):**
  - The parser on the real script: sentence count, 8+ GFX cues and B-ROLL cues found, the "cheat sheet" phrase anchor, flags stripped.
  - The aligner on synthetic transcripts: a repeated take, a skipped line, an ad-lib, a filler gap.
  - The compiler: frame snapping, padding, pause cap, merging, and the timeline map round trip.
  - The ffmpeg and HyperFrames argument builders.
- **Offline end-to-end fixture (committed):**
  - Build a fake recording with macOS `say` reading two script sections, with one deliberate retake and inserted "um"s, laid over `testsrc2` at 2560×1440 and 30 fps.
  - Use recorded transcripts from both engines (local and `whisper-1`) and a recorded plan fixture. The test runs once per engine fixture, so CI never needs a key or a model download.
  - Run import → render, then assert:
    - `ffprobe` duration = kept segments + intro + outro, within 1 frame.
    - Audio and video durations match.
    - Loudness measures −14 ±1 LUFS.
    - A frame grab inside each overlay window differs from the frame without it.
    - Chapters start at 0:00.
    - SRT times are inside the output duration.
- **Live checks:**
  - A real `claude -p` run of the edit plan and one graphic on the fixture.
  - The UI driven with the built-in browser (`preview_start` from `.claude/launch.json`): toggle a cut and confirm the preview re-concats, swap a take, nudge a graphic, render. Screenshot as proof.
- **Real footage:** Hamza records 2–3 minutes reading the cold open of video 1, with one retake and some ums. Run the full pipeline. He judges whether the cuts are clean and the graphics land on the right words.

## Things Hamza does during the build

1. *Optional:* put `OPENAI_API_KEY` in `fde-editor/.env` if he wants the API engine in the bake-off or later. Claude never types or handles the key, and the local engine needs nothing.
2. Switch `gh` to the personal account.
3. Pick one of 3 brand directions.
4. Record a 2–3 minute test take.
5. Approve the first push. Recordings, screenshots and `projects/` stay gitignored, so job posts and recruiter material never reach the public repo.

## Out of scope for v1

- Export to Resolve or OTIO.
- Word-by-word editing by typing in the transcript (cuts toggle by clicking words and spans instead).
- HDR sources.
- Vertical X clips.
- Multi-camera.
- AI B-roll generation.
- Cloud rendering.

## Changes since approval (2026-10-11)

- **Framing:** `speakerSide` can be `left`, `right` or `center`. A centered speaker gets graphics on either side, chosen per graphic by Claude and flippable in the UI. A new `split` layout puts a pair or comparison on both sides of him.
- **Transcription default:** local **Parakeet**, per the Phase 0 bake-off (`docs/spikes.md`): it keeps ums and repeated words, which every Whisper size drops.
- **Brand:** direction A, "Field Notes", was picked (`brand/directions/`).
- **Burned-in captions** for X clips use a transparent HyperFrames layer, because this ffmpeg has no libass.
