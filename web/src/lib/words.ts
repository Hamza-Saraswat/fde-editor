// What the edit does to each transcript word, and how the transcript reads on screen. Pure.
import type { Cut, CutReason, Edit, FillerCandidate, TakeOption, Transcript, Word } from "../types.ts";

const mid = (w: Pick<Word, "start" | "end">) => (w.start + w.end) / 2;

/** Every word in playback order: clips in edit.clipOrder (unknown clips last), then by time. */
export function readingOrder(transcript: Transcript, clipOrder: string[] = []): Word[] {
  const rank = new Map(clipOrder.map((c, i) => [c, i]));
  const firstSeen = new Map<string, number>();
  transcript.words.forEach((w, i) => {
    if (!firstSeen.has(w.clipId)) firstSeen.set(w.clipId, i);
  });
  const clipRank = (c: string) => rank.get(c) ?? clipOrder.length + (firstSeen.get(c) ?? 0);
  return [...transcript.words].sort((a, b) => clipRank(a.clipId) - clipRank(b.clipId) || a.start - b.start || a.end - b.end);
}

export type WordIndex = { order: Word[]; pos: Map<string, number>; byClip: Map<string, Word[]>; clipPos: Map<string, number> };

export function indexWords(order: Word[]): WordIndex {
  const pos = new Map<string, number>();
  const byClip = new Map<string, Word[]>();
  const clipPos = new Map<string, number>();
  order.forEach((w, i) => {
    pos.set(w.id, i);
    const list = byClip.get(w.clipId) ?? [];
    clipPos.set(w.id, list.length);
    list.push(w);
    byClip.set(w.clipId, list);
  });
  return { order, pos, byClip, clipPos };
}

/** Words of a take option: by word ids when they resolve, else by its time span. */
export function optionWords(idx: WordIndex, opt: TakeOption): Word[] {
  const a = idx.clipPos.get(opt.startWordId);
  const b = idx.clipPos.get(opt.endWordId);
  const list = idx.byClip.get(opt.clipId) ?? [];
  const sameClip = list[a ?? -1]?.id === opt.startWordId && list[b ?? -1]?.id === opt.endWordId;
  if (a !== undefined && b !== undefined && sameClip) return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  return list.filter((w) => mid(w) >= opt.start && mid(w) <= opt.end);
}

/** Words between two ids in reading order, inclusive, in either direction. */
export function wordsBetween(idx: WordIndex, aId: string, bId: string): Word[] {
  const a = idx.pos.get(aId);
  const b = idx.pos.get(bId);
  if (a === undefined || b === undefined) return [];
  return idx.order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export const wordsText = (words: Word[]) => words.map((w) => w.text).join(" ");

export type WordStatus =
  | { kind: "kept" }
  | { kind: "cut"; cutId: string; reason: CutReason } // removed by an enabled cut
  | { kind: "restored"; cutId: string; reason: CutReason } // a cut covers it but is switched off
  | { kind: "alt"; groupId: string; option: number }; // inside a take that isn't chosen

const covers = (c: Pick<Cut, "clipId" | "start" | "end">, w: Word) => c.clipId === w.clipId && mid(w) >= c.start && mid(w) <= c.end;

/** Status of every word under the edit. Enabled cuts win over unchosen takes, which win over disabled cuts. */
export function wordStatuses(idx: WordIndex, edit: Edit): Map<string, WordStatus> {
  const out = new Map<string, WordStatus>();
  for (const w of idx.order) out.set(w.id, { kind: "kept" });

  for (const c of edit.cuts) {
    if (c.enabled) continue;
    for (const w of idx.byClip.get(c.clipId) ?? []) if (covers(c, w)) out.set(w.id, { kind: "restored", cutId: c.id, reason: c.reason });
  }
  for (const g of edit.takeGroups) {
    const chosen = g.options[g.chosen];
    const keep = new Set(chosen ? optionWords(idx, chosen).map((w) => w.id) : []);
    g.options.forEach((opt, i) => {
      if (i === g.chosen) return;
      for (const w of optionWords(idx, opt)) if (!keep.has(w.id)) out.set(w.id, { kind: "alt", groupId: g.id, option: i });
    });
  }
  for (const c of edit.cuts) {
    if (!c.enabled) continue;
    for (const w of idx.byClip.get(c.clipId) ?? []) if (covers(c, w)) out.set(w.id, { kind: "cut", cutId: c.id, reason: c.reason });
  }
  return out;
}

/** Cuts that remove no words (silences, voiced gaps), keyed by the word they follow ("" = start of clip). */
export function wordlessCuts(idx: WordIndex, edit: Edit): Map<string, Cut[]> {
  const out = new Map<string, Cut[]>();
  for (const c of edit.cuts) {
    const list = idx.byClip.get(c.clipId) ?? [];
    if (list.some((w) => covers(c, w))) continue;
    let after = "";
    for (const w of list) if (w.end <= c.start + 1e-6) after = w.id;
    const key = after || `^${c.clipId}`;
    out.set(key, [...(out.get(key) ?? []), c]);
  }
  return out;
}

/** Voiced-gap filler candidates (no word of their own), keyed by the word they follow. */
export function gapFillers(transcript: Transcript): Map<string, FillerCandidate[]> {
  const out = new Map<string, FillerCandidate[]>();
  for (const f of transcript.fillers) {
    if (f.kind !== "gap" || !f.afterWordId) continue;
    out.set(f.afterWordId, [...(out.get(f.afterWordId) ?? []), f]);
  }
  return out;
}

/** Word ids Whisper/Parakeet wrote as fillers ("um", "uh"). */
export const fillerWordIds = (transcript: Transcript) =>
  new Set(transcript.fillers.filter((f) => f.kind === "token" && f.wordId).map((f) => f.wordId!));

export type Line = { clipId: string; words: Word[]; clipStart: boolean };

/** Group words into reading lines: break after sentence-final punctuation, on long pauses, at clip changes. */
export function toLines(order: Word[], opts: { maxWords?: number; pauseSec?: number } = {}): Line[] {
  const maxWords = opts.maxWords ?? 22;
  const pauseSec = opts.pauseSec ?? 0.9;
  const lines: Line[] = [];
  let cur: Line | null = null;
  let prev: Word | null = null;
  for (const w of order) {
    const clipChange = !prev || prev.clipId !== w.clipId;
    const pause = prev && !clipChange && w.start - prev.end > pauseSec;
    const sentenceEnd = prev && /[.!?…]["”’)]?$/.test(prev.text);
    if (!cur || clipChange || pause || (sentenceEnd && cur.words.length >= 6) || cur.words.length >= maxWords) {
      cur = { clipId: w.clipId, words: [], clipStart: clipChange };
      lines.push(cur);
    }
    cur.words.push(w);
    prev = w;
  }
  return lines;
}
