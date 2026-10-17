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
for (let i = 1; i < tl.segments.length; i++) {
  const A = tl.segments[i - 1]!, B = tl.segments[i]!;
  const lastA = keptWords.filter((w) => w.clipId === A.clipId && (w.start + w.end) / 2 <= A.end).at(-1);
  const firstB = keptWords.find((w) => w.clipId === B.clipId && (w.start + w.end) / 2 >= B.start);
  const outA = lastA ? sourceToOutput(tl, lastA.clipId, Math.min(lastA.end, A.end - 1e-3)) : null;
  const outB = firstB ? sourceToOutput(tl, firstB.clipId, Math.max(firstB.start, B.start + 1e-3)) : null;
  const gap = outA !== null && outB !== null ? outB - outA : NaN;
  const removed = edit.cuts.filter((c) => c.enabled && c.clipId === A.clipId && c.start < B.start && c.end > A.end).map((c) => c.reason);
  if (gap < 0.12) tight++;
  console.log(`#${i} out ${(B.outStart).toFixed(2)}  "${lastA?.text}" → "${firstB?.text}"  gap ${gap.toFixed(2)} s  removed ${(B.start - A.end).toFixed(2)} s [${[...new Set(removed)].join(",") || "pause/other"}]  segB ${(B.frames / tl.fps).toFixed(2)} s`);
}
console.log(`\nsegments < 0.6 s: ${short}; joins with < 120 ms between words: ${tight} of ${tl.segments.length - 1}`);
