# fde-editor

A local, script-aware video editor for long-form talking-head YouTube videos.

You write a script with `**SAY**` blocks and `> GFX:` / `> B-ROLL:` cues, then record yourself reading
it. fde-editor matches the recording to the script, and then:

- **Claude Code (Opus) plans the edit.** It picks the best take of every line, cuts ums, stumbles, false
  starts and dead air, and decides where each graphic lands, down to the word.
- **Claude builds every motion graphic** as a [HyperFrames](https://github.com/heygen-com/hyperframes)
  composition in the channel's brand, timed to the spoken words and rendered as a transparent overlay.
- **You review everything in one screen.** Undo any cut, swap takes, nudge or flip graphics, attach
  and crop screenshots.
- **ffmpeg renders the final MP4** with frame-accurate cuts, graphics, an optional intro and end card, and loudness
  levelled to −14 LUFS. It also writes YouTube chapters, an SRT captions file, and 2–3 captioned
  clips for X.

Everything runs on your Mac. Claude runs through your own `claude` CLI login, so no Anthropic API key is
needed. Transcription is local by default (NVIDIA Parakeet via HyperFrames). The OpenAI `whisper-1`
API is an optional second engine.

## Requirements

- macOS on Apple Silicon (VideoToolbox encoders), Node ≥ 22, pnpm, ffmpeg (`brew install ffmpeg`)
- [Claude Code](https://claude.com/claude-code), logged in: `claude auth login`
- Optional: `OPENAI_API_KEY` in `.env` for the whisper-1 engine

## Setup

```bash
pnpm install
```

```bash
pnpm brand
```

`pnpm brand` validates the brand templates and renders the intro and default end card (about 2 min).

```bash
pnpm dev
```

Then open http://localhost:5317. The API runs on 127.0.0.1:4317 and is never exposed to the network.

The first local transcription downloads the Parakeet model. HyperFrames handles this.

## How a video goes through it

| Step | What happens | Who |
|---|---|---|
| **Import** | probe clips, make 720p proxies, extract 48 kHz and ASR audio, parse the script | ffmpeg |
| **Transcribe** | word timestamps for every clip, silence detection, filler candidates (filler words plus voiced gaps), alignment to the script | Parakeet / Whisper / whisper-1 |
| **Plan edit** | takes, cuts, ad-lib decisions, graphic anchors and briefs → `edit.json` | Claude Code (`claude -p`, read-only tools, JSON schema) |
| **Preview** | frame-accurate keep segments, cached by content hash, joined with the concat demuxer. The audio is crossfaded at every cut. A listen-back pass re-transcribes the preview and cuts any um still audible | ffmpeg + Parakeet |
| **Graphics** | one HyperFrames composition per cue, linted, snapshotted, rendered to ProRes 4444 with alpha plus a VP9-alpha preview | Claude Code + HyperFrames |
| **Render** | A-roll + overlays + intro + end card, two-pass loudnorm, H.264 BT.709, chapters, SRT | ffmpeg |
| **X clips** | Claude picks 30–60 s moments; each gets burned-in brand captions | Claude Code + HyperFrames |

Each video lives in `projects/<slug>/` as plain JSON plus media. This folder is gitignored and is never
committed, because it holds recordings and screenshots.

## Framing

Set where you sit in frame per video: **left third**, **right third**, or **centered**.

- **On a third:** graphics go on the open side.
- **Centered:** each graphic goes left or right. Claude alternates sides, and you can flip any graphic.
  The `split` layout puts a comparison on both sides of you.

## Edit style

How hard a video is cut. The channel defaults are in `fde-editor.config.json` (`edit.style` and
`edit.maxPauseMs`). Each video can override them in the review screen's Overview panel, and a change
applies straight away, with no new Claude plan.

| Setting | Default | What it does |
|---|---|---|
| Ums and uhs | Natural | Keeps the short "uh" of fluent speech and cuts only stalls. Cut all and Keep all are the alternatives. |
| Stutters | Natural | Keeps a small stutter or a short aside when cutting it would splice inside running speech. Clean cuts them anyway; Light keeps every stutter. |
| Cut stalls longer than | 400 ms | The length at which a filler counts as a stall. |
| Trim pauses longer than | 1.5 s | Only dead air is trimmed. Shorter pauses are your timing and stay, so a cut never saves less than 0.6 s. |
| Trim them down to | 0.7 s | What is left of a trimmed pause. |
| Keep cuts at least this far apart | 3 s | Two cuts closer than this leave a sliver between two jumps: the smaller stutter gives way, or the two merge. |
| Jump cuts | Punch-in | A cut switches between the normal and a ~10% closer framing. Hard is a plain cut; Dissolve is a 4-frame dissolve. |
| Hold each framing at least | 4 s | A cut sooner than this after the last framing change keeps the framing, so the picture never pumps in and out. |

Restarts, false starts and corrections are cut. A cut that leaves running speech keeps the restart's own
pause, so the restart lands like a new sentence. A cut never removes the opening of the next sentence or
leaves a word said on both sides of it. A cut you switch on or off yourself is never changed by the style.
The Overview shows cuts per minute, pause trims and framing changes, so you can keep videos consistent.

**Camera handling.** The editor measures how much the picture moves. A reach to the phone in a pause
is cut ("Camera touched" in the cut list, with any word said during it). A reach to stop the recording
during the last word freezes the picture on the last clean frame while the word finishes. Videos end
with a half-second fade instead of the brand intro and end card, which are off by default (Output tab).

## Picture fixes

- **Letterboxed recordings** are cropped automatically when you add them. CapCut's teleprompter, for
  example, saves a 16:9 shot inside a 9:16 frame.
- **Mirror and Stabilize** are switches per recording, in the setup view and the Overview.
  - Mirror un-flips a front camera.
  - Stabilize removes camera shake such as table knocks. It uses OpenCV (`scripts/stabilize.py`) and
    holds the camera still in the background. It adds about 1–2% of zoom to hide the edges, capped at
    6%.
  - Either switch builds one corrected copy of the recording that everything else reads from. It has
    the same frames, timing and audio as the original. The preview then rebuilds, with no
    re-transcribing.
- **Stabilize needs `python3` with `cv2`.** If that's missing, the editor runs the official
  `opencv-python-headless` package through `uv`.

## Script format

```markdown
## 1. What an AI engineer is (0:40–2:00)

**SAY**

An AI engineer builds software on top of AI models that somebody else trained.

> GFX: three-layer stack builds bottom-up …
> B-ROLL: the job posting pops in on the open side. Crop out the header …
```

- Headings after the H1 become sections, and therefore chapters.
- `` `[CONFIRM …]` `` and `` `[VERIFY …]` `` notes are stripped from spoken text.
- `## Description` and `## Before you record` are ignored.

## Brand

`brand/` holds the locked **Field Notes** look:

- `kit/`: Newsreader + IBM Plex Mono (both OFL), tokens, components
- `BRAND.md`: the spec Claude follows
- `templates/`: lint-clean reference compositions
- `previews/`: stills of each template

Run `pnpm brand` after changing anything there.

## Tests

```bash
pnpm test
```

```bash
pnpm test:e2e
```

```bash
pnpm typecheck
```

`pnpm test` runs the unit and integration suite (seconds). `pnpm test:e2e` is the offline end-to-end
run on the committed fixture take (a few minutes).

Phase 0 measurements behind the design choices are in `docs/spikes.md`, and the full design is in
`docs/design.md`.

### Running a Claude step by hand

`scripts/claude-steps.ts` splits each Claude step into a `prepare-*` and an `apply-*` command:

- `prepare-*` prints exactly what the headless run would get: the prompt, the system prompt file, the inputs
  and the schema.
- `apply-*` feeds an answer through the same validation and rendering the server uses.

This is handy for debugging a prompt, or for running a step from an interactive Claude Code session.

## Credits

- HyperFrames skills in `.claude/skills/` are vendored from heygen-com/hyperframes v0.8.134 (Apache-2.0).
  See `.claude/skills/VENDORED.md`.
- Word normalization and loudness logic are ported from the author's BLAI pipeline. See `NOTICE.md`.
- Edit-decision-list design was informed by browser-use/video-use (MIT). No code was copied.
