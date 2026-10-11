// Source time <-> output time through the derived timeline's segments. Pure.
import type { Timeline, Word } from "../types.ts";

const EPS = 1e-6;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** Output seconds for a source time, or null when that moment was cut. */
export function sourceToOutput(tl: Timeline, clipId: string, t: number): number | null {
  for (const s of tl.segments) {
    if (s.clipId === clipId && t >= s.start - EPS && t <= s.end + EPS) return s.outStart + clamp(t - s.start, 0, s.end - s.start);
  }
  return null;
}

/** Source clip and time for an output time, or null outside the timeline. */
export function outputToSource(tl: Timeline, outT: number): { clipId: string; t: number } | null {
  const segs = tl.segments;
  if (!segs.length || outT < -EPS || outT > tl.duration + EPS) return null;
  for (const s of segs) {
    const len = s.frames / tl.fps;
    if (outT >= s.outStart - EPS && outT < s.outStart + len - EPS) return { clipId: s.clipId, t: s.start + clamp(outT - s.outStart, 0, len) };
  }
  const last = segs.at(-1)!;
  return { clipId: last.clipId, t: last.end };
}

/** Index of the segment playing at output time t (-1 when the timeline is empty). */
export function segmentIndexAt(tl: Timeline, t: number): number {
  const segs = tl.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (segs[m]!.outStart <= t + EPS) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

export type WordTime = { id: string; start: number; end: number }; // output seconds

/** Output times of the words that play (their midpoint falls in a segment), in output order. */
export function wordOutputTimes(tl: Timeline, words: Word[]): WordTime[] {
  const out: WordTime[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const s = tl.segments.find((seg) => seg.clipId === w.clipId && mid >= seg.start - EPS && mid <= seg.end + EPS);
    if (!s) continue;
    const len = s.end - s.start;
    out.push({ id: w.id, start: s.outStart + clamp(w.start - s.start, 0, len), end: s.outStart + clamp(w.end - s.start, 0, len) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** The word being spoken at output time t (the last word started, if it ended less than `hold` seconds ago). */
export function wordAt(times: WordTime[], t: number, hold = 0.35): string | null {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (times[m]!.start <= t + EPS) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  if (ans < 0) return null;
  const w = times[ans]!;
  return t <= w.end + hold ? w.id : null;
}
