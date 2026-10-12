import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths } from "../src/core/paths.ts";
import { EditSchema, TranscriptSchema } from "../src/core/schema.ts";
import { loadConfig, loadProject, readJson } from "../src/core/store.ts";
import { buildTimeline, outputToSource } from "../src/core/timeline.ts";
import { FILLER_WORDS, normalizeWords } from "../src/core/normalize.ts";
const slug = process.argv[2]!; const p = projectPaths(slug);
const [edit, tr, project, config] = [await readJson(p.edit, EditSchema), await readJson(p.transcript, TranscriptSchema), await loadProject(slug), await loadConfig()];
const tl = buildTimeline(edit, tr, project.clips, config);
const heard = JSON.parse(readFileSync(join(p.cacheDir, "roundtrip", "transcript.json"), "utf8")) as { text: string; start: number; end: number }[];
for (const h of heard.filter((w) => normalizeWords(w.text).some((t) => FILLER_WORDS.has(t)))) {
  const src = outputToSource(tl, (h.start + h.end) / 2)!;
  const near = tr.words.filter((w) => w.clipId === src.clipId && w.end > src.t - 0.6 && w.start < src.t + 0.6).map((w) => `${w.text}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`).join(" ");
  const cand = tr.fillers.filter((f) => f.clipId === src.clipId && f.end > src.t - 0.3 && f.start < src.t + 0.3);
  const cuts = edit.cuts.filter((c) => c.clipId === src.clipId && c.end > src.t - 0.3 && c.start < src.t + 0.3).map((c) => `${c.reason}/${c.by}/${c.enabled ? "on" : "OFF"}[${c.start.toFixed(2)}-${c.end.toFixed(2)}]`);
  console.log(`heard "${h.text}" @out ${h.start.toFixed(2)} → src ${src.t.toFixed(2)} | cand: ${cand.map((f) => f.kind + "[" + f.start.toFixed(2) + "-" + f.end.toFixed(2) + "]").join(",") || "none"} | cuts: ${cuts.join(",") || "none"}\n   words: ${near}`);
}
