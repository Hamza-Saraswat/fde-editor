// Upload sidecars, as pure functions: YouTube chapter list and SRT captions mapped through the edit.
import { isFillerWord } from "../core/normalize.ts";
import type { Segment, Timeline, Word } from "../core/schema.ts";

// ---------- chapters ----------

export const MIN_CHAPTER_SECONDS = 10;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 75 -> "1:15"; 3725 -> "1:02:05". Whole seconds, rounded down (how YouTube reads them). */
export function chapterTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

/**
 * YouTube chapter list for the description. Rules: the first chapter is 0:00 (with an intro it
 * absorbs the intro), every chapter is at least 10 s (a chapter closer than that to the previous
 * one is dropped), at least 3 chapters or nothing. Times are A-roll seconds shifted by the intro.
 * Pass `totalSeconds` to also drop a final chapter shorter than 10 s.
 */
export function chaptersText(chapters: { title: string; start: number }[], introSeconds = 0, totalSeconds?: number): string {
  const items = chapters
    .map((c) => ({ title: c.title.replace(/\s+/g, " ").trim(), t: Math.max(0, Math.floor(c.start + introSeconds)) }))
    .filter((c) => c.title)
    .sort((a, b) => a.t - b.t);
  if (!items.length) return "";
  items[0]!.t = 0;
  const kept = [items[0]!];
  for (const c of items.slice(1)) {
    if (c.t - kept[kept.length - 1]!.t >= MIN_CHAPTER_SECONDS) kept.push(c);
  }
  if (totalSeconds !== undefined) {
    while (kept.length > 1 && Math.floor(totalSeconds) - kept[kept.length - 1]!.t < MIN_CHAPTER_SECONDS) kept.pop();
  }
  if (kept.length < 3) return "";
  return kept.map((c) => `${chapterTime(c.t)} ${c.title}`).join("\n");
}

// ---------- captions ----------

export type SrtOptions = {
  maxLineChars?: number; // 42
  maxLines?: number; // 2
  maxCueSeconds?: number; // 6
  pauseSeconds?: number; // a gap longer than this starts a new cue (0.6)
  minCueSeconds?: number; // short cues linger up to this long if the next cue allows (0.8)
};

/** 3725.5 -> "01:02:05,500" */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms % 1000).padStart(3, "0")}`;
}

/** Split text into ≤ maxLines lines of ≤ max chars, balancing two lines; null if it can't fit. */
export function wrapCaption(text: string, max = 42, maxLines = 2): string[] | null {
  if (text.length <= max) return [text];
  if (maxLines < 2) return null;
  const words = text.split(" ");
  let best: string[] | null = null;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    if (a.length > max) break;
    if (b.length <= max) {
      const score = Math.max(a.length, b.length);
      if (score < bestScore) [best, bestScore] = [[a, b], score];
    } else if (maxLines > 2) {
      const rest = wrapCaption(b, max, maxLines - 1);
      if (rest && Math.max(a.length, ...rest.map((l) => l.length)) < bestScore) {
        best = [a, ...rest];
        bestScore = Math.max(a.length, ...rest.map((l) => l.length));
      }
    }
  }
  return best;
}

type Placed = { text: string; start: number; end: number };

/** Map one source time range through the timeline; null when the word's midpoint was cut. */
function locator(timeline: Timeline) {
  const byClip = new Map<string, Segment[]>();
  for (const s of timeline.segments) {
    const list = byClip.get(s.clipId) ?? [];
    list.push(s);
    byClip.set(s.clipId, list);
  }
  for (const list of byClip.values()) list.sort((a, b) => a.start - b.start);
  return (clipId: string, start: number, end: number): { start: number; end: number } | null => {
    const list = byClip.get(clipId);
    if (!list) return null;
    const mid = (start + end) / 2;
    let lo = 0;
    let hi = list.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (list[m]!.start <= mid) [hit, lo] = [m, m + 1];
      else hi = m - 1;
    }
    const seg = hit >= 0 ? list[hit]! : null;
    if (!seg) return null;
    const len = seg.frames / timeline.fps;
    if (mid >= seg.start + len) return null;
    const clamp = (t: number) => Math.min(len, Math.max(0, t - seg.start));
    return { start: seg.outStart + clamp(start), end: seg.outStart + clamp(end) };
  };
}

const endsSentence = (text: string) => /[.?!…]["'”’)\]]*$/.test(text);

/**
 * SRT captions for the final render: every kept word (midpoint inside a segment) mapped to output
 * time + intro, fillers dropped, script spelling preferred, grouped into cues of ≤ 2 lines × 42
 * chars and ≤ 6 s, breaking after sentence punctuation and at pauses > 0.6 s.
 */
export function srtFromTimeline(
  words: Word[],
  timeline: Timeline,
  introSeconds = 0,
  scriptWordsByWordId?: Map<string, string>,
  opts: SrtOptions = {},
): string {
  const maxChars = opts.maxLineChars ?? 42;
  const maxLines = opts.maxLines ?? 2;
  const maxCue = opts.maxCueSeconds ?? 6;
  const pause = opts.pauseSeconds ?? 0.6;
  const minCue = opts.minCueSeconds ?? 0.8;
  const locate = locator(timeline);

  const placed: Placed[] = [];
  const mapped = words
    .filter((w) => !isFillerWord(w.text))
    .map((w) => {
      const at = locate(w.clipId, w.start, w.end);
      if (!at) return null;
      const spelled = scriptWordsByWordId?.has(w.id) ? scriptWordsByWordId.get(w.id)! : w.text;
      return { text: spelled.replace(/\s+/g, " ").trim(), start: at.start + introSeconds, end: at.end + introSeconds };
    })
    .filter((w): w is Placed => w !== null)
    .sort((a, b) => a.start - b.start);
  for (const w of mapped) {
    // a script word can span several spoken words ("2026" <- "twenty twenty six"); the extra
    // ones come through empty and only stretch the previous word's timing
    const prev = placed[placed.length - 1];
    if (!w.text) {
      if (prev) prev.end = Math.max(prev.end, w.end);
      continue;
    }
    placed.push({ ...w });
  }

  const cues: { start: number; end: number; lines: string[] }[] = [];
  let cur: Placed[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(" ");
    cues.push({ start: cur[0]!.start, end: Math.max(...cur.map((w) => w.end)), lines: wrapCaption(text, maxChars, maxLines) ?? [text] });
    cur = [];
  };
  for (const w of placed) {
    const last = cur[cur.length - 1];
    if (last) {
      const text = [...cur.map((x) => x.text), w.text].join(" ");
      const breakHere = endsSentence(last.text) || w.start - last.end > pause || w.end - cur[0]!.start > maxCue ||
        wrapCaption(text, maxChars, maxLines) === null;
      if (breakHere) flush();
    }
    cur.push(w);
  }
  flush();

  // no overlaps; very short cues linger a little when there is room
  cues.forEach((c, i) => {
    const next = cues[i + 1]?.start ?? Infinity;
    if (c.end - c.start < minCue) c.end = Math.min(c.start + minCue, next);
    c.end = Math.max(Math.min(c.end, next), c.start + 0.001);
  });

  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join("\n")}\n`).join("\n");
}
