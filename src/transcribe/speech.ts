// ASR word stamps can swallow silence: Parakeet stamped "team." as 21.6–39.2 s when the speaker went
// quiet for 17 s after it, and the editor (which treats a word's span as speech) kept all of it.
// Trim every word to the speech part of its stamp using the detected silences, so long pauses become
// real gaps between words that the timeline's pause cap can shorten.
import type { Span, Word } from "../core/schema.ts";

/** Silences at least this long inside a word stamp are treated as not part of the word. */
export const MIN_INNER_SILENCE = 0.25;
const MIN_WORD = 0.05;
const EDGE = 0.04;

export function trimWordsToSpeech(words: Word[], silences: Span[], minSilence = MIN_INNER_SILENCE): Word[] {
  const byClip = new Map<string, Span[]>();
  for (const s of silences) {
    if (s.end - s.start < minSilence) continue;
    const list = byClip.get(s.clipId) ?? [];
    list.push(s);
    byClip.set(s.clipId, list);
  }
  for (const list of byClip.values()) list.sort((a, b) => a.start - b.start);

  return words.map((w) => {
    let { start, end } = w;
    for (const s of byClip.get(w.clipId) ?? []) {
      if (s.end <= start || s.start >= end) continue;
      if (s.start <= start + EDGE && s.end < end - MIN_WORD) {
        start = s.end; // leading silence: the word starts after it
      } else if (s.start > start + MIN_WORD) {
        end = s.start; // silence after the word began: the word ends where it starts
        break;
      }
    }
    if (end - start < MIN_WORD) return w; // nothing sensible left: keep the original stamp
    return start === w.start && end === w.end ? w : { ...w, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  });
}
