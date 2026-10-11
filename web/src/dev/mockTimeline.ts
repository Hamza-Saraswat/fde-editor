// Mock-mode stand-in for the server's timeline compiler (src/core/timeline.ts): same idea, fewer
// edge cases. Never used against the real server, which returns its own timeline.
import type { Clip, Edit, Timeline, Transcript, Word } from "../types.ts";
import { indexWords, optionWords, readingOrder } from "../lib/words.ts";

const PRE = 0.08;
const POST = 0.12;
const MAX_PAUSE = 0.4;
const mid = (w: Word) => (w.start + w.end) / 2;

export function mockTimeline(edit: Edit, transcript: Transcript, clips: Clip[], fps: number): Timeline {
  const order = readingOrder(transcript, edit.clipOrder);
  const idx = indexWords(order);
  const removed = new Set<string>();
  const blockedByClip = new Map<string, { start: number; end: number }[]>();
  const block = (clipId: string, start: number, end: number) => blockedByClip.set(clipId, [...(blockedByClip.get(clipId) ?? []), { start, end }]);

  for (const c of edit.cuts) {
    if (!c.enabled) continue;
    block(c.clipId, c.start, c.end);
    for (const w of idx.byClip.get(c.clipId) ?? []) if (mid(w) >= c.start && mid(w) <= c.end) removed.add(w.id);
  }
  for (const g of edit.takeGroups) {
    const chosen = g.options[g.chosen];
    const keep = new Set(chosen ? optionWords(idx, chosen).map((w) => w.id) : []);
    g.options.forEach((o, i) => {
      if (i === g.chosen) return;
      const ws = optionWords(idx, o).filter((w) => !keep.has(w.id));
      ws.forEach((w) => removed.add(w.id));
      if (ws.length) block(o.clipId, ws[0]!.start, ws.at(-1)!.end);
    });
  }

  const segments: Timeline["segments"] = [];
  const segFirst: string[] = [];
  let outFrame = 0;
  for (const clipId of edit.clipOrder) {
    const words = idx.byClip.get(clipId) ?? [];
    const duration = clips.find((c) => c.id === clipId)?.duration ?? (words.at(-1)?.end ?? 0) + 1;
    const blocked = [...(blockedByClip.get(clipId) ?? []), ...words.filter((w) => removed.has(w.id))];
    const islands: { first: Word; last: Word }[] = [];
    let prevKept = -1;
    words.forEach((w, i) => {
      if (removed.has(w.id)) return;
      const cur = islands.at(-1);
      if (cur && i - prevKept === 1 && w.start - cur.last.end <= MAX_PAUSE) cur.last = w;
      else islands.push({ first: w, last: w });
      prevKept = i;
    });
    const spans: { sf: number; ef: number; first: string }[] = [];
    for (const isl of islands) {
      let lo = 0;
      let hi = duration;
      for (const r of blocked) {
        if (r.end <= isl.first.start + 1e-6) lo = Math.max(lo, r.end);
        if (r.start >= isl.last.end - 1e-6) hi = Math.min(hi, r.start);
      }
      const start = Math.max(lo, isl.first.start - PRE);
      const end = Math.min(hi, isl.last.end + POST);
      const sf = Math.round(start * fps);
      const ef = Math.round(end * fps);
      const prev = spans.at(-1);
      if (prev && sf <= prev.ef) prev.ef = Math.max(prev.ef, ef);
      else if (ef - sf >= 2) spans.push({ sf, ef, first: isl.first.id });
    }
    for (const s of spans) {
      segments.push({ clipId, start: s.sf / fps, end: s.ef / fps, frames: s.ef - s.sf, outStart: outFrame / fps });
      segFirst.push(s.first);
      outFrame += s.ef - s.sf;
    }
  }
  const duration = outFrame / fps;

  const outOf = (w: Word, t: number): number | null => {
    const s = segments.find((seg) => seg.clipId === w.clipId && mid(w) >= seg.start && mid(w) <= seg.end);
    return s ? s.outStart + Math.min(Math.max(t, s.start), s.end) - s.start : null;
  };
  const resolve = (id: string, dir: 1 | -1): Word | null => {
    let p = idx.pos.get(id);
    if (p === undefined) return null;
    for (; p >= 0 && p < order.length; p += dir) if (!removed.has(order[p]!.id) && outOf(order[p]!, order[p]!.start) !== null) return order[p]!;
    return null;
  };

  const overlays: Timeline["overlays"] = [];
  for (const o of edit.overlays) {
    if (!o.enabled) continue;
    const a = resolve(o.anchorWordId, 1);
    if (!a) continue;
    const start = Math.max(0, (outOf(a, a.start) ?? 0) + (o.offsetMs ?? 0) / 1000);
    let end: number;
    if (o.durMs != null) end = start + o.durMs / 1000;
    else {
      const e = resolve(o.endWordId, -1);
      if (!e) continue;
      end = outOf(e, e.end) ?? start;
    }
    end = Math.min(end, duration);
    if (end - start >= 0.5) overlays.push({ overlayId: o.id, cueId: o.cueId, start, end });
  }
  overlays.sort((x, y) => x.start - y.start);

  const chapters: Timeline["chapters"] = [];
  for (const ch of edit.chapters) {
    const w = resolve(ch.anchorWordId, 1);
    if (!w) continue;
    const i = segFirst.indexOf(w.id);
    chapters.push({ title: ch.title, start: i >= 0 ? segments[i]!.outStart : (outOf(w, w.start) ?? 0) });
  }
  chapters.sort((x, y) => x.start - y.start);

  return { fps, segments, duration, overlays, chapters };
}
