// For each filler the listen-back heard in the preview: the edited audio's loudness around it, the
// source it plays from (segments + cuts nearby) and the source loudness there.
// Usage: tsx spikes/why-heard.ts <slug>   (after spikes/roundtrip.ts has written the heard transcript)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFillerWord } from "../src/core/normalize.ts";
import { projectPaths } from "../src/core/paths.ts";
import { EditSchema, TranscriptSchema } from "../src/core/schema.ts";
import { loadConfig, loadProject, readJson } from "../src/core/store.ts";
import { buildTimeline, keptWordIds } from "../src/core/timeline.ts";
import { loadEnvelope, type Envelope } from "../src/media/energy.ts";

const slug = process.argv[2]!;
const p = projectPaths(slug);
const [edit, tr, project, config] = [await readJson(p.edit, EditSchema), await readJson(p.transcript, TranscriptSchema), await loadProject(slug), await loadConfig()];
const tl = buildTimeline(edit, tr, project.clips, config);
const kept = keptWordIds(edit, tr);
const heard = JSON.parse(readFileSync(join(p.cacheDir, "roundtrip", "transcript.json"), "utf8")) as { text: string; start: number; end: number }[];
const edited = await loadEnvelope(join(p.cacheDir, "roundtrip", "edited.wav"));
const clip = project.clips[0]!;
const src = await loadEnvelope([p.asrWav(clip.id), p.wav(clip.id)].find((x) => existsSync(x))!);
const row = (env: Envelope, a: number, b: number) => {
  const out: string[] = [];
  for (let t = a; t < b - 1e-9; t += 0.02) out.push((env.rms[Math.floor(t / env.hop)]! / env.speech).toFixed(2).replace(/^0/, ""));
  return out.join(" ");
};
for (const [i, w] of heard.entries()) {
  if (!isFillerWord(w.text)) continue;
  const a = w.start - 0.3, b = w.end + 0.3;
  console.log(`\n"${w.text}" heard ${w.start.toFixed(2)}-${w.end.toFixed(2)}   ${heard.slice(Math.max(0, i - 2), i + 3).map((x) => `${x.text}[${x.start.toFixed(2)}]`).join(" ")}`);
  console.log(`  edited from ${a.toFixed(2)}: ${row(edited, a, b)}`);
  for (const s of tl.segments) {
    const se = s.outStart + s.frames / tl.fps;
    if (se < a || s.outStart > b) continue;
    const x = s.start + Math.max(0, a - s.outStart), y = s.start + Math.min(s.frames / tl.fps, b - s.outStart);
    console.log(`  seg out ${s.outStart.toFixed(2)}-${se.toFixed(2)} src ${s.start.toFixed(2)}-${s.end.toFixed(2)}; plays src ${x.toFixed(2)}-${y.toFixed(2)}: ${row(src, x, y)}`);
    const words = tr.words.filter((q) => q.end > x - 0.4 && q.start < y + 0.4).map((q) => `${kept.has(q.id) ? "" : "~"}${q.text}[${q.start.toFixed(2)}-${q.end.toFixed(2)}]`);
    console.log(`    words: ${words.join(" ")}`);
    const cuts = edit.cuts.filter((c) => c.enabled && c.end > x - 0.4 && c.start < y + 0.4).map((c) => `${c.id}:${c.reason} ${c.start.toFixed(2)}-${c.end.toFixed(2)}`);
    console.log(`    cuts: ${cuts.join("; ") || "none"}`);
  }
}
