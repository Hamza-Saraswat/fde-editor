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
import { buildTimeline, keptWordIds } from "../core/timeline.ts";
import { ffmpeg } from "../core/proc.ts";
import { loadEnvelope, valley, voicedCore, type Envelope } from "../media/energy.ts";
import { transcribeLocalFile } from "./local.ts";

export type SweepResult = { heardFillers: number; added: number; skipped: number };

/** A filler heard in the edited audio, with where the listen-back put the words either side (output seconds). */
export type HeardFiller = { start: number; end: number; prevEnd?: number; nextStart?: number };

/** The kept source spans an output range plays, one per segment it touches. */
function keptSpans(timeline: Timeline, start: number, end: number) {
  const out: { clipId: string; start: number; end: number; toSource: (t: number) => number | null }[] = [];
  for (const s of timeline.segments) {
    const segEnd = s.outStart + s.frames / timeline.fps;
    const a = Math.max(start, s.outStart), b = Math.min(end, segEnd);
    const toSource = (t: number) => (t >= s.outStart - 1e-6 && t <= segEnd + 1e-6 ? s.start + (t - s.outStart) : null);
    if (b - a > 0.005) out.push({ clipId: s.clipId, start: toSource(a)!, end: toSource(b)!, toSource });
  }
  return out;
}

const peakIn = (env: Envelope, start: number, end: number) => {
  let v = 0;
  for (let i = Math.floor(start / env.hop); i <= Math.floor(end / env.hop) && i < env.rms.length; i++) v = Math.max(v, env.rms[i] ?? 0);
  return v;
};

/** Pure: which source spans to cut for the fillers heard in the edited audio (output times). */
export function planSweepCuts(
  residual: HeardFiller[],
  timeline: Timeline,
  transcript: Transcript,
  edit: Edit,
  envelopes: Map<string, Envelope>,
): { cuts: Cut[]; skipped: number } {
  const kept = keptWordIds(edit, transcript);
  const cuts: Cut[] = [];
  let skipped = 0;
  for (const r of residual) {
    // A filler heard across a join plays from two places; the one with the voice in it is the filler.
    const spans = keptSpans(timeline, r.start, r.end);
    const loudness = (x: (typeof spans)[number]) => {
      const env = envelopes.get(x.clipId);
      return env ? peakIn(env, x.start, x.end) : x.end - x.start;
    };
    const span = spans.sort((x, y) => loudness(y) - loudness(x))[0];
    if (!span || r.end - r.start > 1.2) { skipped++; continue; }
    const clipId = span.clipId;
    let { start, end } = span;
    const clipWords = transcript.words.filter((w) => w.clipId === clipId && kept.has(w.id));
    const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
    const before = clipWords.filter((w) => mid(w) <= start).at(-1);
    const after = clipWords.find((w) => mid(w) >= end);
    // Never past the middle of a kept neighbour. The quiet gap between the "uh" and its neighbours is the
    // best edge; only when the voice runs straight on into a neighbour (no gap to find) does the
    // re-listen's word edge decide. Its stamps are coarse (up to ~0.1 s early), so it's a fallback.
    const minStart = before ? mid(before) : 0;
    const maxEnd = after ? mid(after) : end + 0.3;
    const env = envelopes.get(clipId);
    if (env) {
      let v = voicedCore(env, start, end, minStart, maxEnd, 0.3);
      const heardPrev = r.prevEnd !== undefined ? span.toSource(r.prevEnd) : null;
      const heardNext = r.nextStart !== undefined ? span.toSource(r.nextStart) : null;
      const runsIntoPrev = v.voiced && before && v.start <= minStart + 0.04 && heardPrev !== null && heardPrev > minStart;
      const runsIntoNext = v.voiced && after && v.end >= maxEnd - 0.04 && heardNext !== null && heardNext < maxEnd;
      if (runsIntoPrev || runsIntoNext) {
        // cut at the quietest point near the heard edge (stamps run early, so look a bit later too)
        const lo = runsIntoPrev ? Math.max(minStart, valley(env, heardPrev! - 0.15, heardPrev! + 0.05, heardPrev!)) : minStart;
        const hi = runsIntoNext ? Math.min(maxEnd, valley(env, heardNext! - 0.05, Math.min(maxEnd, heardNext! + 0.15), heardNext!)) : maxEnd;
        v = voicedCore(env, start, end, lo, hi, 0.3);
      }
      if (!v.voiced) { skipped++; continue; } // heard in silence or a lip click: nothing to cut
      ({ start, end } = v);
    } else if (clipWords.some((w) => w.start < end && w.end > start)) {
      skipped++; // no audio to place it by: only cut what is clear of every kept word
      continue;
    }
    // Never take a kept word; never overrule a filler someone chose to keep, or a cut the user made.
    // (A kept ad-lib is a disabled "adlib" cut: it means "keep these words", not "keep its ums".)
    const touchesKept = clipWords.some((w) => mid(w) > start && mid(w) < end);
    const userDecided = edit.cuts.some((c) => c.clipId === clipId && c.start < end && c.end > start && (c.by === "user" || (!c.enabled && c.reason === "filler")));
    // Already (almost) all inside cuts that are on? Then the cut is there and nothing is left to take.
    const covered = coverage([...edit.cuts, ...cuts].filter((c) => c.clipId === clipId && c.enabled), start, end);
    if (touchesKept || userDecided || covered >= 0.9 * (end - start)) { skipped++; continue; }
    cuts.push({ id: `ks-${clipId}-${Math.round(start * 1000)}`, clipId, start, end, reason: "filler", by: "auto", enabled: true, note: "heard in the preview" });
  }
  return { cuts, skipped };
}

/** Seconds of [start, end] inside the union of the ranges. */
function coverage(ranges: { start: number; end: number }[], start: number, end: number): number {
  const parts = ranges.map((c) => [Math.max(start, c.start), Math.min(end, c.end)] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, at = start;
  for (const [a, b] of parts) {
    if (b <= at) continue;
    total += b - Math.max(a, at);
    at = b;
  }
  return total;
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
  const residual: HeardFiller[] = [];
  heard.forEach((w, i) => {
    if (!isFillerWord(w.text)) return;
    const prev = heard.slice(0, i).reverse().find((x) => !isFillerWord(x.text));
    const next = heard.slice(i + 1).find((x) => !isFillerWord(x.text));
    residual.push({ start: w.start, end: w.end, prevEnd: prev?.end, nextStart: next?.start });
  });

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
