// Turns the word-level edit (edit.json) into frame-snapped keep segments: the derived timeline
// the preview, the renderer and the UI all play from. Pure functions, no I/O.
import type { Clip, Config, Edit, PlacedOverlay, Segment, TakeOption, Timeline, Transcript, Word } from "./schema.ts";

type Range = { start: number; end: number };
const EPS = 1e-6;

// ---------- word lookup shared with the compiler ----------

export type WordIndex = {
  byClip: Map<string, Word[]>; // each clip's words in time order
  byId: Map<string, { word: Word; i: number }>; // i = position inside its clip's list
};

export function indexWords(transcript: Transcript): WordIndex {
  const byClip = new Map<string, Word[]>();
  for (const w of transcript.words) {
    const list = byClip.get(w.clipId) ?? [];
    list.push(w);
    byClip.set(w.clipId, list);
  }
  const byId = new Map<string, { word: Word; i: number }>();
  for (const list of byClip.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end); // stable, so ties keep transcript order
    list.forEach((word, i) => byId.set(word.id, { word, i }));
  }
  return { byClip, byId };
}

/** Words from startWordId to endWordId inclusive, or null when the ids are unknown or in different clips. */
export function wordsInRange(idx: WordIndex, startWordId: string, endWordId: string): Word[] | null {
  const a = idx.byId.get(startWordId);
  const b = idx.byId.get(endWordId);
  if (!a || !b || a.word.clipId !== b.word.clipId) return null;
  const list = idx.byClip.get(a.word.clipId)!;
  const [lo, hi] = a.i <= b.i ? [a.i, b.i] : [b.i, a.i];
  return list.slice(lo, hi + 1);
}

const mid = (w: Word) => (w.start + w.end) / 2;

function optionWords(idx: WordIndex, opt: TakeOption): Word[] {
  const byIds = wordsInRange(idx, opt.startWordId, opt.endWordId);
  if (byIds) return byIds;
  // ids no longer in the transcript (re-transcribed): fall back to the option's time span
  return (idx.byClip.get(opt.clipId) ?? []).filter((w) => mid(w) >= opt.start && mid(w) <= opt.end);
}

// ---------- what the edit removes ----------

type Removal = {
  words: Set<string>; // removed word ids
  ranges: Map<string, Range[]>; // per clip: enabled cuts + unchosen take spans (padding never enters these)
};

function computeRemoval(edit: Edit, idx: WordIndex): Removal {
  const words = new Set<string>();
  const ranges = new Map<string, Range[]>();
  const addRange = (clipId: string, r: Range) => {
    const list = ranges.get(clipId) ?? [];
    list.push(r);
    ranges.set(clipId, list);
  };

  for (const cut of edit.cuts) {
    if (!cut.enabled) continue;
    addRange(cut.clipId, { start: cut.start, end: cut.end });
    for (const w of idx.byClip.get(cut.clipId) ?? []) {
      const m = mid(w);
      if (m >= cut.start && m <= cut.end) words.add(w.id);
    }
  }

  // Words in ANY group's chosen take are protected: an unchosen option of one sentence can overlap
  // the chosen take of another (a short line that also appears inside a longer one).
  const chosenOpts = edit.takeGroups.map((g) => g.options[g.chosen]).filter((o): o is TakeOption => Boolean(o));
  const keep = new Set(chosenOpts.flatMap((o) => optionWords(idx, o).map((w) => w.id)));
  for (const g of edit.takeGroups) {
    g.options.forEach((opt, i) => {
      if (i === g.chosen) return;
      for (const w of optionWords(idx, opt)) if (!keep.has(w.id)) words.add(w.id);
      const overlapsChosen = chosenOpts.some((c) => c.clipId === opt.clipId && opt.start < c.end && opt.end > c.start);
      if (!overlapsChosen) addRange(opt.clipId, { start: opt.start, end: opt.end });
    });
  }
  return { words, ranges };
}

/** Ids of the words that survive the edit (in a clip on the clip order, not cut, not in an unchosen take). */
export function keptWordIds(edit: Edit, transcript: Transcript): Set<string> {
  const idx = indexWords(transcript);
  const { words: removed } = computeRemoval(edit, idx);
  const kept = new Set<string>();
  for (const clipId of edit.clipOrder) {
    for (const w of idx.byClip.get(clipId) ?? []) if (!removed.has(w.id)) kept.add(w.id);
  }
  return kept;
}

// ---------- the timeline ----------

type Island = { first: Word; last: Word; startPad: number; endPad: number };
type Built = { start: number; end: number; firstWordId: string };

export function buildTimeline(edit: Edit, transcript: Transcript, clips: Clip[], config: Config): Timeline {
  const fps = config.output.fps;
  const pre = config.edit.preMs / 1000;
  const post = config.edit.postMs / 1000;
  const maxPause = config.edit.maxPauseMs / 1000;
  const pausePre = Math.max(pre, maxPause / 2);
  const pausePost = Math.max(post, maxPause / 2);

  const idx = indexWords(transcript);
  const removal = computeRemoval(edit, idx);
  const isRemoved = (w: Word) => removal.words.has(w.id);

  const segments: Segment[] = [];
  const segFirstWord: string[] = []; // first kept word of each segment (chapters snap to the cut)
  let outFrame = 0;

  for (const clipId of edit.clipOrder) {
    const words = idx.byClip.get(clipId) ?? [];
    const clip = clips.find((c) => c.id === clipId);
    const duration = clip?.duration ?? (words.at(-1)?.end ?? 0) + post;
    const blocked: Range[] = [
      ...(removal.ranges.get(clipId) ?? []),
      ...words.filter(isRemoved).map((w) => ({ start: w.start, end: w.end })),
    ];

    // 1. group kept words into islands
    const islands: Island[] = [];
    let cur: Island | null = null;
    let prevKeptIdx = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (isRemoved(w)) continue;
      if (cur) {
        const prev: Word = cur.last;
        const hard: boolean = i - prevKeptIdx > 1 || blocked.some((r: Range): boolean => r.start < w.start && r.end > prev.end);
        const pause = !hard && w.start - prev.end > maxPause;
        if (hard || pause) {
          cur.endPad = hard ? post : pausePost;
          islands.push(cur);
          cur = { first: w, last: w, startPad: hard ? pre : pausePre, endPad: post };
        } else {
          cur.last = w;
        }
      } else {
        cur = { first: w, last: w, startPad: pre, endPad: post };
      }
      prevKeptIdx = i;
    }
    if (cur) islands.push(cur);

    // 2. pad, clamped against removed material and the clip bounds
    const built: Built[] = [];
    for (const isl of islands) {
      let lo = 0;
      let hi = duration;
      for (const r of blocked) {
        if (r.start < isl.first.start) lo = Math.max(lo, Math.min(r.end, isl.first.start));
        if (r.end > isl.last.end) hi = Math.min(hi, Math.max(r.start, isl.last.end));
      }
      let start = Math.min(Math.max(isl.first.start - isl.startPad, lo), isl.first.start);
      let end = Math.max(Math.min(isl.last.end + isl.endPad, hi), isl.last.end);
      start = Math.max(0, start);
      end = Math.min(duration, end);
      if (end <= start) continue;
      const prev = built.at(-1);
      if (prev && start <= prev.end + EPS) prev.end = Math.max(prev.end, end);
      else built.push({ start, end, firstWordId: isl.first.id });
    }

    // 3. snap to the frame grid, merge what now touches, drop slivers
    const maxFrame = Math.floor(duration * fps + EPS);
    const snapped: { sf: number; ef: number; firstWordId: string }[] = [];
    for (const b of built) {
      const sf = Math.max(0, Math.round(b.start * fps));
      const ef = Math.min(maxFrame, Math.round(b.end * fps));
      const prev = snapped.at(-1);
      if (prev && sf <= prev.ef) prev.ef = Math.max(prev.ef, ef);
      else snapped.push({ sf, ef, firstWordId: b.firstWordId });
    }
    for (const s of snapped) {
      const frames = s.ef - s.sf;
      if (frames < 2) continue;
      segments.push({ clipId, start: s.sf / fps, end: s.ef / fps, frames, outStart: outFrame / fps });
      segFirstWord.push(s.firstWordId);
      outFrame += frames;
    }
  }

  const timeline: Timeline = { fps, segments, duration: outFrame / fps, overlays: [], chapters: [] };

  // ---------- anchors: overlays and chapters follow their words through the cut ----------

  const kept = new Set<string>();
  const order: Word[] = []; // every word on the clip order, in playback order
  for (const clipId of edit.clipOrder) {
    for (const w of idx.byClip.get(clipId) ?? []) {
      order.push(w);
      if (!isRemoved(w)) kept.add(w.id);
    }
  }
  const orderPos = new Map(order.map((w, i) => [w.id, i]));

  // A word inside an unchosen take maps to the same position in the chosen take, so overlays survive take swaps.
  const remap = (wordId: string): string => {
    for (const g of edit.takeGroups) {
      const chosen = g.options[g.chosen];
      if (!chosen) continue;
      for (let i = 0; i < g.options.length; i++) {
        if (i === g.chosen) continue;
        const ws = optionWords(idx, g.options[i]!);
        const k = ws.findIndex((w) => w.id === wordId);
        if (k < 0) continue;
        const target = optionWords(idx, chosen);
        return target[Math.min(k, target.length - 1)]?.id ?? wordId;
      }
    }
    return wordId;
  };

  const resolve = (wordId: string, dir: 1 | -1): Word | null => {
    if (!idx.byId.has(wordId)) return null;
    const id = removal.words.has(wordId) ? remap(wordId) : wordId;
    let p = orderPos.get(id);
    if (p === undefined) return null;
    for (; p >= 0 && p < order.length; p += dir) if (kept.has(order[p]!.id)) return order[p]!;
    return null;
  };

  const segmentFor = (w: Word): number => {
    let best = -1;
    let bestDist = Infinity;
    segments.forEach((s, i) => {
      if (s.clipId !== w.clipId) return;
      const dist = Math.max(0, s.start - w.end, w.start - s.end);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    });
    return best;
  };
  const outAt = (w: Word, t: number): { t: number; seg: number } | null => {
    const i = segmentFor(w);
    if (i < 0) return null;
    const s = segments[i]!;
    return { t: s.outStart + Math.min(Math.max(t, s.start), s.end) - s.start, seg: i };
  };

  for (const ov of edit.overlays) {
    if (!ov.enabled) continue;
    const a = resolve(ov.anchorWordId, 1);
    const startAt = a && outAt(a, a.start);
    if (!startAt) continue;
    let start = startAt.t + (ov.offsetMs ?? 0) / 1000;
    let end: number;
    if (ov.durMs != null) {
      end = start + ov.durMs / 1000;
    } else {
      const e = resolve(ov.endWordId, -1);
      const endAt = e && outAt(e, e.end);
      if (!endAt) continue;
      end = endAt.t + (ov.offsetMs ?? 0) / 1000; // a nudge moves the whole graphic, it doesn't trim it
    }
    start = clamp(start, 0, timeline.duration);
    end = clamp(end, 0, timeline.duration);
    if (end - start < 0.5) continue;
    timeline.overlays.push({ overlayId: ov.id, cueId: ov.cueId, start, end } satisfies PlacedOverlay);
  }
  timeline.overlays.sort((x, y) => x.start - y.start);

  for (const ch of edit.chapters) {
    const w = resolve(ch.anchorWordId, 1);
    const at = w && outAt(w, w.start);
    if (!at) continue;
    const start = segFirstWord[at.seg] === w.id ? segments[at.seg]!.outStart : at.t;
    timeline.chapters.push({ title: ch.title, start });
  }
  timeline.chapters.sort((x, y) => x.start - y.start);

  return timeline;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

// ---------- mapping between source and output time ----------

/** Output seconds for a source time, or null when that moment was cut. */
export function sourceToOutput(timeline: Timeline, clipId: string, t: number): number | null {
  for (const s of timeline.segments) {
    if (s.clipId === clipId && t >= s.start - EPS && t <= s.end + EPS) {
      return s.outStart + clamp(t - s.start, 0, s.end - s.start);
    }
  }
  return null;
}

/** Source clip and time for an output time, or null outside the timeline. */
export function outputToSource(timeline: Timeline, outT: number): { clipId: string; t: number } | null {
  const segs = timeline.segments;
  if (!segs.length || outT < -EPS || outT > timeline.duration + EPS) return null;
  for (const s of segs) {
    const len = s.frames / timeline.fps;
    if (outT >= s.outStart - EPS && outT < s.outStart + len - EPS) {
      return { clipId: s.clipId, t: s.start + clamp(outT - s.outStart, 0, len) };
    }
  }
  const last = segs.at(-1)!;
  return { clipId: last.clipId, t: last.end };
}
