// Move filler-word boundaries (and their neighbours') to the quiet valleys in the audio, so cutting
// an "uh" takes all of it and none of the words around it. Pure given the envelopes.
import type { FillerCandidate, Word } from "../core/schema.ts";
import { refineSpan, type Envelope } from "../media/energy.ts";

const ms = (t: number) => Math.round(t * 1000) / 1000;

export function refineFillerTokens(words: Word[], fillers: FillerCandidate[], envelopes: Map<string, Envelope>): { words: Word[]; fillers: FillerCandidate[] } {
  const out = words.map((w) => ({ ...w }));
  const index = new Map(out.map((w, i) => [w.id, i]));
  const refinedFillers = fillers.map((f) => {
    if (f.kind !== "token" || !f.wordId) return f;
    const env = envelopes.get(f.clipId);
    const i = index.get(f.wordId);
    if (!env || i === undefined) return f;
    const w = out[i]!;
    const prev = out[i - 1]?.clipId === w.clipId ? out[i - 1] : undefined;
    const next = out[i + 1]?.clipId === w.clipId ? out[i + 1] : undefined;
    // never eat into the first/last 60 % of a neighbouring word
    const minStart = prev ? prev.start + 0.4 * (prev.end - prev.start) : 0;
    const maxEnd = next ? next.end - 0.6 * (next.end - next.start) : w.end + 0.3;
    const r = refineSpan(env, w.start, w.end, minStart, maxEnd);
    w.start = ms(r.start);
    w.end = ms(r.end);
    if (prev && prev.end > w.start) prev.end = w.start;
    if (next && next.start < w.end) next.start = w.end;
    return { ...f, start: w.start, end: w.end };
  });
  return { words: out, fillers: refinedFillers };
}
