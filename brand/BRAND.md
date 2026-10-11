# Field Notes: graphics brand for the FDE / AI engineering channel

Every motion graphic in a video uses this spec. It reads as an engineer's notebook: warm paper cards,
an editorial serif voice, and mono labels for annotations. Exactly one orange emphasis per graphic.
Graphics are **transparent overlays** on a talking-head video at **2560×1440, 30 fps**.

## The kit (already copied into your folder as `kit/`)

```html
<link rel="stylesheet" href="kit/tokens.css" />     <!-- fonts + colour/type/motion tokens -->
<link rel="stylesheet" href="kit/components.css" /> <!-- zones, cards, labels, chips, checklist, list, stat, screenshot -->
<script src="kit/gsap.min.js"></script>
```

Fonts are **Newsreader** (serif: titles and body) and **IBM Plex Mono** (labels, data, small print). Never
name any other font. No external URLs of any kind: no CDNs, no Google Fonts, no remote images.

## Colours (CSS variables)

| Token | Use |
|---|---|
| `--fn-paper` `#f4efe6` | card surface |
| `--fn-ink` `#17140f` | text |
| `--fn-muted` `#6b6358` | labels, secondary text |
| `--fn-rule` / `--fn-border` | hairlines, card edge |
| `--fn-signal` `#e8501a` | **the** emphasis: one word, one chip, one highlighted card, one stat. Never body text. |
| `--fn-signal-soft` | marker highlight behind words (`.fn-mark`) |
| `--fn-pine` `#2f5d50` | secondary accent: "Definition" labels, a "good" state |

The canvas background stays transparent (`html, body` are transparent in `components.css`). The only
exceptions are the intro and end card templates, which are full-frame.

## Zones: where a graphic may sit

Hamza's position in frame decides the zone. `input.json` tells you `speakerSide`, `layout` and `side`.
Put everything inside the zone `div` (`class="fn-zone" data-zone="…"`) and never cross into his part
of the frame.

| Framing (`speakerSide`) | layout `side` | layout `split` | layout `full` |
|---|---|---|---|
| `left` third | `right-wide` (x 1180–2440) | n/a: use `right-wide` | `full` |
| `right` third | `left-wide` (x 120–1380) | n/a: use `left-wide` | `full` |
| `center` | `left-narrow` (x 100–860) **or** `right-narrow` (x 1700–2460), per `side` | **both** narrow zones, one card each | `full` |

Lower-thirds use `lower-third-left` / `lower-third-right`, under the speaker. For a centred speaker, use
`lower-third-left`. Zones are 1200 px tall and centre their content vertically. Add class `top` or
`bottom` to push it up or down.

## Components (`components.css`)

- `.fn-card` (+ `.signal` orange outline for the one emphasised card, `.tight` less padding)
- `.fn-label` mono caps (+ `.signal`, `.pine`)
- `.fn-hero` 120 px, `.fn-h1` 76 px, `.fn-h2` 56 px, `.fn-body` 40 px, `.fn-mono` 30 px
- `.fn-mark`: a marker highlight. Animate `--fn-mark` from `0%` to `100%` to draw it on.
- `.fn-chip` (+ `.quiet`, `.pine`)
- `.fn-check` (+ `.done` / `.todo`) with `<span class="box"><svg viewBox="0 0 24 24"><path class="tick" d="M4 12.5l5 5L20 6.5"/></svg></span>`
- `.fn-list` with `<li><span>…</span><span class="meta">…</span></li>`
- `.fn-stat`: one big orange number
- `.fn-row`: side-by-side children of equal width
- `.fn-lower-third` with `.name` and `.role`
- `.fn-shot` screenshot frame: `.viewport` plus the layout script from `templates/screenshot`; `.blur`, `.hl` boxes

## Type rules

- Smallest text on canvas: **34 px** for anything meant to be read, 22 px only for mono fine print.
- Titles: 6 words or fewer. A whole graphic: about 30 words or fewer. Use Hamza's own words from the
  script or the transcript. Keep numbers, names and prices exactly as the cue gives them, and never
  invent a fact, number, logo or quote.
- No emoji. Sentence case for titles; mono labels are uppercase (the class does it).

## Motion

The motion language is calm and editorial, never bouncy.

- **Enter** from the frame edge the zone is nearest: right zones from `x: 80`, left zones from
  `x: -80`, lower-thirds from `y: 40`. Fade in with opacity. 0.45 s, `power3.out`.
- **Children** stagger 0.08 s (`opacity` + `y: 14`, 0.35 s, `power2.out`).
- **Beats land on the spoken word.** `input.json → words[]` gives each word's time relative to the
  graphic's start. Start an element's entrance about 0.1 s before its word.
- **Marker highlight:** `--fn-mark` 0% → 100%, 0.35–0.4 s, `power2.out`.
- **Check tick:** `strokeDasharray: 30, strokeDashoffset: 30 → 0`, 0.3 s, starting 0.3 s after its row.
- **Exit** everything at `D − 0.35` (D = `data-duration`), 0.35 s, `power2.in`, toward the edge it came
  from (`x: ±40`). The exit must end **exactly** at D.
- Hold still between beats: no idle loops, pulsing, bouncing, shaking or spinning. One entrance per
  element, at most one emphasis animation, one exit.

## Technical contract (HyperFrames)

- Root: `<div id="root" data-composition-id="main" data-start="0" data-duration="D" data-width="2560" data-height="1440">`,
  where **D = `input.json → durationSec`** (to 2 decimals).
- Every timed element: `class="clip"`, a unique `id`, `data-start`, `data-duration`, `data-track-index`.
  Usually one clip per zone, spanning 0 to D.
- One paused GSAP timeline registered as `window.__timelines["main"]`. Nothing may animate before 0 or
  after D.
- Deterministic: no `Math.random()`, no `Date`, no network, no timers. A one-off layout script that runs
  at load (like the screenshot template's) is fine.
- Images: only files in `assets/` (copied there for you). Screenshots must use the crop, blur and highlight
  rects from `input.json`. **Anything that identifies a company, recruiter or person stays cropped out or
  blurred.** Never remove a blur box.

## Templates (`brand/templates/*/index.html`): start from the closest one

| Template | Use for |
|---|---|
| `side-card` | one concept, definition or quote card |
| `job-cards` | two related cards stacked in one zone, the second entering on a later word |
| `split-compare` | layout `split`: A vs B on both sides of a centred speaker |
| `checklist` | a list that builds item by item and holds through a section |
| `list-ladder` | ranked or priced rows (price ladder, top-3, steps) |
| `screenshot` | B-roll job posts and messages with crop, blur and highlight |
| `lower-third` | name and role |
| `intro` / `outro` | full-frame sting and end card (rendered by the pipeline, not per cue) |

Previews of each are in `brand/previews/*.png`.
