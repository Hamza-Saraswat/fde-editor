// Filler candidates: places the edit might want to cut.
//   token: the ASR wrote a filler word ("um", "uh", …).
//   gap:   a pause between two words that is long enough to matter but mostly NOT silent — the speaker
//          was making a sound there that the ASR dropped (Whisper routinely omits "um"s).
// Pure function; the caller supplies words (already merged/sorted) and detected silences.
import { isFillerWord } from "../core/normalize.ts";
import type { FillerCandidate, Span, Word } from "../core/schema.ts";

/** Air (seconds) left on each side of a cut voiced gap, so the words on either side never butt together. */
export const GAP_AIR = 0.04;
/** A gap counts as voiced when less than this fraction of it is covered by detected silence. */
export const MAX_SILENT_FRACTION = 0.25;
const EPS = 1e-6;

export type FillerConfig = { edit: { fillerGapMs: number } };

/** Total length of [start, end] covered by `spans` (sorted by start, non-overlapping). */
function coveredLength(spans: { start: number; end: number }[], start: number, end: number): number {
  // binary search for the first span that ends after `start`
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.end <= start) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.start >= end) break;
    total += Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
  }
  return total;
}

/** Merge overlapping spans of one clip into a sorted, disjoint list. */
function mergeSpans(spans: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

export function findFillerCandidates(words: Word[], silences: Span[], config: FillerConfig): FillerCandidate[] {
  const minGap = config.edit.fillerGapMs / 1000;

  // clip order = order of first appearance in `words` (words come in clip order), then any others
  const clipRank = new Map<string, number>();
  for (const w of words) if (!clipRank.has(w.clipId)) clipRank.set(w.clipId, clipRank.size);

  const silenceByClip = new Map<string, { start: number; end: number }[]>();
  for (const s of silences) {
    const list = silenceByClip.get(s.clipId) ?? [];
    list.push(s);
    silenceByClip.set(s.clipId, list);
  }
  for (const [clipId, list] of silenceByClip) silenceByClip.set(clipId, mergeSpans(list));

  const found: Omit<FillerCandidate, "id">[] = [];

  for (const w of words) {
    if (isFillerWord(w.text)) found.push({ clipId: w.clipId, start: w.start, end: w.end, kind: "token", wordId: w.id });
  }

  for (let i = 0; i + 1 < words.length; i++) {
    const prev = words[i]!;
    const next = words[i + 1]!;
    if (prev.clipId !== next.clipId) continue;
    const gap = next.start - prev.end;
    if (gap + EPS < minGap || gap <= 0) continue;
    const silent = coveredLength(silenceByClip.get(prev.clipId) ?? [], prev.end, next.start);
    if (silent / gap >= MAX_SILENT_FRACTION) continue;
    // Keep ~40 ms of air on each side so cutting the gap never butts two words together.
    const air = Math.min(GAP_AIR, gap / 4);
    const ms = (t: number) => Math.round(t * 1000) / 1000;
    found.push({ clipId: prev.clipId, start: ms(prev.end + air), end: ms(next.start - air), kind: "gap", afterWordId: prev.id });
  }

  const rank = (clipId: string) => clipRank.get(clipId) ?? Number.MAX_SAFE_INTEGER;
  found.sort((a, b) =>
    rank(a.clipId) - rank(b.clipId) || a.clipId.localeCompare(b.clipId) || a.start - b.start || a.end - b.end);
  return found.map((f, i) => ({ id: `f${i}`, ...f }));
}
