// Diagnose how an edit sounds: long silences that survived in the edited audio (and why), and the
// character of every cut join (gap between the words either side, segment lengths).
// Usage: tsx spikes/diagnose-cut.ts <slug>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "../src/core/paths.ts";
import { EditSchema, TranscriptSchema } from "../src/core/schema.ts";
import { loadConfig, loadProject, readJson } from "../src/core/store.ts";
import { buildTimeline, keptWordIds, outputToSource, sourceToOutput } from "../src/core/timeline.ts";
import { loadEnvelope } from "../src/media/energy.ts";

const slug = process.argv[2]!;
const p = projectPaths(slug);
const [edit, tr, project, config] = [await readJson(p.edit, EditSchema), await readJson(p.transcript, TranscriptSchema), await loadProject(slug), await loadConfig()];
const tl = buildTimeline(edit, tr, project.clips, config);
const kept = keptWordIds(edit, tr);
const keptWords = tr.words.filter((w) => kept.has(w.id));
const work = join(p.cacheDir, "diagnose");
mkdirSync(work, { recursive: true });
const wav = join(work, "edited.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", p.preview, "-vn", "-ac", "1", "-ar", "16000", wav]);

// 1. long silences in the edited audio
const sd = spawnSync("ffmpeg", ["-i", wav, "-af", "silencedetect=noise=-38dB:d=0.55", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const starts = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]!);
const ends = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]!);
console.log(`\n=== silences >= 0.55 s in the edited audio (${starts.length}) ===`);
starts.forEach((s, i) => {
  const e = ends[i] ?? tl.duration;
  const a = outputToSource(tl, s + 0.01), b = outputToSource(tl, e - 0.01);
  const segs = tl.segments.filter((g) => g.outStart < e && g.outStart + g.frames / tl.fps > s).length;
  const ctx = a ? tr.words.filter((w) => w.clipId === a.clipId && w.end > a.t - 1 && w.start < (b?.t ?? a.t) + 1)
    .map((w) => `${kept.has(w.id) ? "" : "~"}${w.text}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(" ") : "";
  const inWord = a && b ? keptWords.filter((w) => w.clipId === a.clipId && w.start < b.t && w.end > a.t).map((w) => `${w.text}(${(w.end - w.start).toFixed(2)}s)`) : [];
  console.log(`out ${s.toFixed(2)}-${e.toFixed(2)} (${(e - s).toFixed(2)} s) src ${a?.t.toFixed(2)}-${b?.t.toFixed(2)} spans ${segs} seg(s)` +
    `${inWord.length ? ` INSIDE kept word stamp(s): ${inWord.join(", ")}` : ""}\n   ${ctx}`);
});

// 2. joins
console.log(`\n=== joins (${tl.segments.length - 1}) ===`);
const short = tl.segments.filter((g) => g.frames / tl.fps < 0.6).length;
let tight = 0;
// level at the join (quietest 10 ms within ±15 ms) against the 60 ms either side: a hole in the
// sound at a cut shows up as a deep dip where the speech on both sides is loud
const env = await loadEnvelope(wav);
const lvl = (a: number, b: number) => {
  const xs: number[] = [];
  for (let i = Math.floor(a / env.hop); i < Math.ceil(b / env.hop); i++) xs.push(env.rms[i] ?? 0);
  return xs;
};
const dips: number[] = [];
for (let i = 1; i < tl.segments.length; i++) {
  const A = tl.segments[i - 1]!, B = tl.segments[i]!;
  const lastA = keptWords.filter((w) => w.clipId === A.clipId && (w.start + w.end) / 2 <= A.end).at(-1);
  const firstB = keptWords.find((w) => w.clipId === B.clipId && (w.start + w.end) / 2 >= B.start);
  const outA = lastA ? sourceToOutput(tl, lastA.clipId, Math.min(lastA.end, A.end - 1e-3)) : null;
  const outB = firstB ? sourceToOutput(tl, firstB.clipId, Math.max(firstB.start, B.start + 1e-3)) : null;
  const gap = outA !== null && outB !== null ? outB - outA : NaN;
  const removed = edit.cuts.filter((c) => c.enabled && c.clipId === A.clipId && c.start < B.start && c.end > A.end).map((c) => c.reason);
  const around = [...lvl(B.outStart - 0.075, B.outStart - 0.015), ...lvl(B.outStart + 0.015, B.outStart + 0.075)];
  const ref = Math.sqrt(around.reduce((n, x) => n + x * x, 0) / around.length);
  const dip = 20 * Math.log10(Math.max(1e-6, Math.min(...lvl(B.outStart - 0.015, B.outStart + 0.015))) / Math.max(1e-6, ref));
  if (gap < 0.12) {
    tight++;
    if (ref > env.speech * 0.3) dips.push(dip);
  }
  console.log(`#${i} out ${(B.outStart).toFixed(2)}  "${lastA?.text}" → "${firstB?.text}"  gap ${gap.toFixed(2)} s  removed ${(B.start - A.end).toFixed(2)} s [${[...new Set(removed)].join(",") || "pause/other"}]  segB ${(B.frames / tl.fps).toFixed(2)} s`);
}
console.log(`\nsegments < 0.6 s: ${short}; joins with < 120 ms between words: ${tight} of ${tl.segments.length - 1}`);
dips.sort((a, b) => a - b);
if (dips.length) console.log(`level dip at tight joins inside speech (${dips.length}): median ${dips[Math.floor(dips.length / 2)]!.toFixed(1)} dB, worst ${dips[0]!.toFixed(1)} dB`);
