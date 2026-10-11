// Burned-in captions for X clips. This ffmpeg has no libass/drawtext, so captions are a
// transparent HyperFrames layer (brand fonts) rendered to ProRes 4444 and overlaid by ffmpeg.
// Style: short single-line phrases in the lower middle, the spoken word lights up in the brand orange.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isFillerWord } from "../core/normalize.ts";
import { renderComposition, stageKit } from "./hyperframes.ts";

export type CaptionWord = { text: string; start: number; end: number }; // seconds, relative to the clip

export type CaptionCue = { start: number; end: number; words: CaptionWord[] };

/** Group words into short phrases: ≤ 28 chars, break at punctuation or a pause > 0.45 s, never > 2.5 s. */
export function groupCaptions(words: CaptionWord[], maxChars = 28, maxSec = 2.5): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length) cues.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, words: cur });
    cur = [];
  };
  for (const w of words.filter((x) => !isFillerWord(x.text) && x.text.trim())) {
    const prev = cur[cur.length - 1];
    const text = [...cur, w].map((x) => x.text.trim()).join(" ");
    if (prev && (text.length > maxChars || w.start - prev.end > 0.45 || w.end - cur[0]!.start > maxSec)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.text.trim())) flush();
  }
  flush();
  // Hold each cue until the next one starts (max +0.6 s), so captions don't flicker off between phrases.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    cues[i]!.end = next ? Math.min(next.start, cues[i]!.end + 0.6) : cues[i]!.end + 0.6;
  }
  return cues;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

export function captionsHtml(cues: CaptionCue[], durationSec: number, width: number, height: number): string {
  const D = f(durationSec);
  const scale = width / 1920;
  const cueHtml = cues
    .map((c, i) => `<div class="cue" id="c${i}">${c.words.map((w, j) => `<span id="c${i}w${j}">${esc(w.text.trim())}</span>`).join(" ")}</div>`)
    .join("\n      ");
  const tl = cues
    .map((c, i) => [
      `tl.set("#c${i}", { autoAlpha: 1 }, ${f(c.start)});`,
      ...c.words.map((w, j) => `tl.set("#c${i}w${j}", { color: "var(--fn-signal)" }, ${f(w.start)}); tl.set("#c${i}w${j}", { color: "var(--fn-paper)" }, ${f(Math.min(w.end + 0.05, c.end))});`),
      `tl.set("#c${i}", { autoAlpha: 0 }, ${f(Math.min(c.end, durationSec))});`,
    ].join("\n      "))
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=${width}, height=${height}" />
  <link rel="stylesheet" href="kit/tokens.css" />
  <link rel="stylesheet" href="kit/components.css" />
  <script src="kit/gsap.min.js"></script>
  <style>
    #bar { position: absolute; left: 0; right: 0; bottom: ${Math.round(110 * scale)}px; display: flex; justify-content: center; }
    .cue { position: absolute; bottom: 0; visibility: hidden; opacity: 0; white-space: nowrap;
      font-family: var(--fn-serif); font-weight: 600; font-size: ${Math.round(68 * scale)}px; line-height: 1.15;
      color: var(--fn-paper); background: rgba(23, 20, 15, 0.84); padding: ${Math.round(14 * scale)}px ${Math.round(30 * scale)}px;
      border-radius: ${Math.round(12 * scale)}px; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${width}" data-height="${height}">
    <div id="bar" class="clip" data-start="0" data-duration="${D}" data-track-index="1">
      ${cueHtml}
    </div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
      ${tl}
    tl.set({}, {}, ${D});
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
`;
}

/** Render a transparent caption layer of `durationSec` to `outMov`; returns outMov. */
export async function renderCaptionLayer(
  words: CaptionWord[],
  durationSec: number,
  outMov: string,
  opts: { width: number; height: number; fps: number; signal?: AbortSignal; workDir: string },
): Promise<string> {
  const dir = join(opts.workDir, "captions-comp");
  await mkdir(dir, { recursive: true });
  await stageKit(dir);
  await writeFile(join(dir, "index.html"), captionsHtml(groupCaptions(words), durationSec, opts.width, opts.height));
  return renderComposition(dir, outMov, { format: "mov", fps: opts.fps, signal: opts.signal });
}
