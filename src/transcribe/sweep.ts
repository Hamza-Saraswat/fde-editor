// Listen-back sweep: re-transcribe the EDITED preview and cut any um/uh that is still audible.
// The first transcript misses some fillers (Parakeet folds a soft "um" into the word next to it); the
// edited audio, heard in a different context, often reveals them. Each residual filler is mapped back
// to its source time, its edges are moved to the quiet valleys, and it becomes an auto cut — unless it
// would touch a kept word, or the user already decided about that spot.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isFillerWord } from "../core/normalize.ts";
import { projectPaths } from "../core/paths.ts";
import { EditSchema, TranscriptSchema, type Cut, type Edit, type Timeline, type Transcript } from "../core/schema.ts";
import { loadConfig, loadProject, readJson, writeJson } from "../core/store.ts";
import { buildTimeline, keptWordIds, outputToSource } from "../core/timeline.ts";
import { ffmpeg } from "../core/proc.ts";
import { loadEnvelope, voicedCore, type Envelope } from "../media/energy.ts";
import { transcribeLocalFile } from "./local.ts";

export type SweepResult = { heardFillers: number; added: number; skipped: number };

/** Pure: which source spans to cut for the fillers heard in the edited audio (output times). */
export function planSweepCuts(
  residual: { start: number; end: number }[],
  timeline: Timeline,
  transcript: Transcript,
  edit: Edit,
  envelopes: Map<string, Envelope>,
): { cuts: Cut[]; skipped: number } {
  const kept = keptWordIds(edit, transcript);
  const cuts: Cut[] = [];
  let skipped = 0;
  for (const r of residual) {
    const a = outputToSource(timeline, r.start);
    const b = outputToSource(timeline, r.end);
    if (!a || !b || a.clipId !== b.clipId) { skipped++; continue; }
    let start = Math.min(a.t, b.t), end = Math.max(a.t, b.t);
    if (end - start > 1.2) { skipped++; continue; } // spans a large cut: too ambiguous to place
    const clipWords = transcript.words.filter((w) => w.clipId === a.clipId && kept.has(w.id));
    const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
    const before = clipWords.filter((w) => mid(w) <= start).at(-1);
    const after = clipWords.find((w) => mid(w) >= end);
    const env = envelopes.get(a.clipId);
    if (env) ({ start, end } = voicedCore(env, start, end, before ? mid(before) : 0, after ? mid(after) : end + 0.3));
    // Never take a kept word; never overrule a filler someone chose to keep, or a cut the user made.
    // (A kept ad-lib is a disabled "adlib" cut: it means "keep these words", not "keep its ums".)
    const touchesKept = clipWords.some((w) => mid(w) > start && mid(w) < end);
    const userDecided = edit.cuts.some((c) => c.clipId === a.clipId && c.start < end && c.end > start && (c.by === "user" || (!c.enabled && c.reason === "filler")));
    // Mostly inside a cut that's already on? Then it's the coarticulated edge of an um that was cut:
    // going further would clip the next word, so leave it.
    const overlap = (c: Cut) => Math.max(0, Math.min(c.end, end) - Math.max(c.start, start));
    const redundant = [...edit.cuts, ...cuts].some((c) => c.clipId === a.clipId && c.enabled && overlap(c) >= 0.5 * (end - start));
    if (touchesKept || userDecided || redundant) { skipped++; continue; }
    cuts.push({ id: `ks-${a.clipId}-${Math.round(start * 1000)}`, clipId: a.clipId, start, end, reason: "filler", by: "auto", enabled: true, note: "heard in the preview" });
  }
  return { cuts, skipped };
}

export async function sweepResidualFillers(slug: string, opts: { signal?: AbortSignal } = {}): Promise<SweepResult> {
  const paths = projectPaths(slug);
  const [config, project, edit, transcript] = await Promise.all([
    loadConfig(), loadProject(slug), readJson(paths.edit, EditSchema), readJson(paths.transcript, TranscriptSchema),
  ]);
  if (!existsSync(paths.preview)) return { heardFillers: 0, added: 0, skipped: 0 };
  const timeline = buildTimeline(edit, transcript, project.clips, config);

  const work = join(paths.cacheDir, "sweep");
  await mkdir(work, { recursive: true });
  const wav = join(work, "edited.wav");
  await ffmpeg(["-i", paths.preview, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { signal: opts.signal });
  // Parakeet keeps fillers; Whisper drops them, so the sweep always listens with Parakeet.
  const heard = await transcribeLocalFile(wav, join(work, "asr"), { engine: "parakeet", model: config.transcription.localModel, durationSec: timeline.duration, signal: opts.signal });
  const residual = heard.filter((w) => isFillerWord(w.text));

  const envelopes = new Map<string, Envelope>();
  for (const clip of project.clips) {
    const f = [paths.asrWav(clip.id), paths.wav(clip.id)].find((x) => existsSync(x));
    if (f) envelopes.set(clip.id, await loadEnvelope(f));
  }
  const { cuts: added, skipped } = planSweepCuts(residual, timeline, transcript, edit, envelopes);
  const fresh = added.filter((c) => !edit.cuts.some((x) => x.id === c.id));
  if (fresh.length) await writeJson(paths.edit, EditSchema, { ...edit, version: edit.version + 1, cuts: [...edit.cuts, ...fresh] });
  return { heardFillers: residual.length, added: fresh.length, skipped };
}
