// Join pass: where cuts land and whether they are worth making, the way dialogue editors work.
// - Cut a whole flub: a stumble or restart takes the "uh" next to it, or that "uh" gives the restart away.
// - Never orphan a word: a stumble cut keeps the last attempt at a script word, even when the transcriber
//   misheard it ("clod" for "Claude").
// - Join in the quiet between words: cut edges move to the quietest point beside the stamp.
// - A tiny stutter stays when the only way to cut it is a splice inside continuous speech, and a slurred
//   sentence ending is never trimmed off. A content cut (false start, aside, correction) that can't land
//   in a pause keeps a beat of quiet at the join instead.
// Deterministic and reversible: every pass starts from what the planner decided (cut.wanted, cut.orig),
// so changing the style can always be undone. Pure, given the clips' loudness envelopes.
import { valley, type Envelope } from "../media/energy.ts";
import { isFillerWord, normalizeWords } from "./normalize.ts";
import type { Cut, Edit, ScriptDoc, Transcript, Word } from "./schema.ts";
import type { Style } from "./style.ts";
import { keptWordIds } from "./timeline.ts";

const ABSORB_GAP = 0.3; // a filler this close to a flub belongs to it
const SNAP_REACH = 0.12; // how far an edge may move to find the quiet between words
const QUIET_JOIN = 0.08; // this much quiet at a join counts as a pause
const SMALL_STUTTER = 0.6; // longer stumbles are cut even mid-flow (leaving them would be worse)
export const BREATHE_MS = 250;

const DISFLUENT = new Set<Cut["reason"]>(["stumble", "repeat", "filler"]);
const STOP = new Set(["the", "and", "for", "that", "this", "with", "you", "are", "was", "but", "not", "its", "it's", "can", "has"]);

/** Consonant skeleton of a word, so a misheard word still matches its script word ("clod" ~ "Claude" ~ KLD). */
export function skeleton(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, "").replace(/ph/g, "f").replace(/ck/g, "k").replace(/[cq]/g, "k").replace(/x/g, "ks").replace(/z/g, "s");
  return w.replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1");
}

const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
const endsSentence = (w: Word) => /[.?!]["')\]]*$/.test(w.text.trim());
const tokensOf = (w: Word) => normalizeWords(w.text).filter((t) => !isFillerWord(t));

export type JoinContext = {
  transcript: Transcript;
  script: ScriptDoc;
  envelopes: Map<string, Envelope>;
  style: Style;
};

/** Cuts the join pass may change: not the user's, not pinned, not silence trims. */
export const joinControls = (c: Cut) => c.by !== "user" && !c.pinned && c.reason !== "user" && c.reason !== "silence";

export function applyJoins(edit: Edit, ctx: JoinContext): Edit {
  const { transcript, script, envelopes, style } = ctx;
  const byClip = new Map<string, Word[]>();
  for (const w of transcript.words) (byClip.get(w.clipId) ?? byClip.set(w.clipId, []).get(w.clipId)!).push(w);
  for (const list of byClip.values()) list.sort((a, b) => a.start - b.start);

  // start from the planner's cuts; fillers keep what the edit style decided (applyStyle runs first)
  let cuts: Cut[] = edit.cuts.map((c) => {
    if (!joinControls(c)) return c;
    const wanted = c.wanted ?? c.enabled;
    const orig = c.orig ?? { start: c.start, end: c.end };
    const { breathe: _b, join: _j, ...rest } = c;
    return { ...rest, wanted, orig, start: orig.start, end: orig.end, enabled: c.reason === "filler" ? c.enabled : wanted };
  });
  const kept = keptWordIds({ ...edit, cuts }, transcript);
  const sentenceTokens = new Map(script.sentences.map((s) => [s.id, new Set(s.tokens)]));
  const takeOf = (c: Cut) => edit.takeGroups.find((g) => {
    const o = g.options[g.chosen];
    return o && o.clipId === c.clipId && c.start >= o.start - 0.05 && c.end <= o.end + 0.05;
  });
  const absorbed = new Set<string>();
  cuts = cuts.map((c) => {
    if (!joinControls(c) || !c.enabled || c.reason === "filler" || c.reason === "adlib") return c;
    const words = byClip.get(c.clipId) ?? [];
    let { start, end } = c;
    // 1. whole flub: take the hesitation on either side with it
    for (let grew = true; grew;) {
      grew = false;
      const after = words.find((w) => w.start >= end - 0.02);
      if (after && after.start - end < ABSORB_GAP && isFillerWord(after.text)) {
        end = after.end;
        grew = true;
      }
      const before = [...words].reverse().find((w) => w.end <= start + 0.02);
      if (before && start - before.end < ABSORB_GAP && isFillerWord(before.text)) {
        start = before.start;
        grew = true;
      }
      for (const f of transcript.fillers) {
        if (f.clipId !== c.clipId || f.kind !== "gap") continue;
        if (f.start >= end - 0.02 && f.start - end < ABSORB_GAP) { end = f.end; grew = true; }
        if (f.end <= start + 0.02 && start - f.end < ABSORB_GAP) { start = f.start; grew = true; }
      }
    }
    for (const f of cuts) if (f.reason === "filler" && f.clipId === c.clipId && f.start >= start - 0.02 && f.end <= end + 0.02 && f.id !== c.id) absorbed.add(f.id);

    // 2. never orphan a script word: keep the last attempt of one the cut would remove entirely
    if (c.reason === "stumble" || c.reason === "repeat") {
      const g = takeOf(c);
      const script = new Set<string>();
      for (const sid of g?.sentenceIds ?? []) for (const t of sentenceTokens.get(sid) ?? []) if (t.length >= 3 && !STOP.has(t)) script.add(skeleton(t));
      const removed = words.filter((w) => mid(w) >= start && mid(w) <= end);
      const option = g?.options[g.chosen];
      const keptInTake = option ? words.filter((w) => kept.has(w.id) && w.start >= option.start - 0.01 && w.end <= option.end + 0.01 && !removed.includes(w)) : [];
      const has = (w: Word, k: string) => tokensOf(w).some((t) => skeleton(t) === k);
      for (const k of script) {
        if (k.length < 2) continue;
        const hits = removed.filter((w) => has(w, k));
        if (hits.length && !keptInTake.some((w) => has(w, k))) end = Math.min(end, hits.at(-1)!.start);
      }
    }
    if (end - start < 0.05) return { ...c, enabled: false };
    return { ...c, start, end };
  });
  cuts = cuts.map((c) => (absorbed.has(c.id) ? { ...c, enabled: false } : c));

  // 3. join in the quiet, 4. judge each join
  const keptNow = keptWordIds({ ...edit, cuts }, transcript);
  return finish(edit, cuts.map((c) => {
    if (!joinControls(c) || !c.enabled) return c;
    const env = envelopes.get(c.clipId);
    const words = byClip.get(c.clipId) ?? [];
    const prev = [...words].reverse().find((w) => keptNow.has(w.id) && mid(w) < c.start);
    const next = words.find((w) => keptNow.has(w.id) && mid(w) > c.end);
    let { start, end } = c;
    if (env && c.reason !== "filler") {
      start = valley(env, Math.max(prev ? mid(prev) : start - SNAP_REACH, start - SNAP_REACH), Math.min(start + 0.04, end), start);
      end = valley(env, Math.max(end - 0.04, start + 0.02), Math.min(next ? mid(next) : end + SNAP_REACH, end + SNAP_REACH), end);
      if (end <= start) ({ start, end } = c);
    }
    const quiet = (a: number, b: number) => !env || quietFor(env, a, b) >= QUIET_JOIN;
    const removed = words.filter((w) => mid(w) >= start && mid(w) <= end);
    const join = {
      quietBefore: quiet(start - QUIET_JOIN, start),
      quietAfter: quiet(end, end + QUIET_JOIN),
      continuation: !!prev && !endsSentence(prev),
      newSentence: removed.some(endsSentence),
    };
    const midFlow = !join.quietBefore && !join.quietAfter;
    const mismatch = join.continuation && join.newSentence;
    const base = { ...c, start, end, join };

    if (DISFLUENT.has(c.reason)) {
      const g = takeOf(c);
      const sentence = new Set((g?.sentenceIds ?? []).flatMap((sid) => [...(sentenceTokens.get(sid) ?? [])]));
      const removedTokens = removed.flatMap(tokensOf);
      // a correction: the cut words aren't in the script, and the next word brings the script's word in
      // their place ("about 50%, 15%" → the script says 15%)
      const correction = c.reason !== "filler" && removedTokens.some((t) => !sentence.has(t)) && !!next && tokensOf(next).some((t) => sentence.has(t) && !removedTokens.includes(t));
      if (!correction) {
        // a slurred sentence ending stays: trimming it leaves the sentence hanging mid-intonation
        if (c.reason !== "filler" && mismatch && removed.length && endsSentence(removed.at(-1)!)) return { ...base, enabled: false };
        if (style.disfluencies === "light" && c.reason !== "filler") return { ...base, enabled: false };
        if (style.disfluencies === "natural" && midFlow && end - start <= SMALL_STUTTER) return { ...base, enabled: false };
        return base;
      }
    }
    // content cut (false start, aside, correction, long stumble) that can't land in a pause: keep a beat
    return midFlow || mismatch ? { ...base, breathe: BREATHE_MS } : base;
  }));
}

/** Longest run of quiet (below the voicing threshold) inside [from, to], in seconds. */
function quietFor(env: Envelope, from: number, to: number): number {
  const thr = Math.max(0.004, env.speech * 0.2);
  let best = 0, run = 0;
  for (let i = Math.max(0, Math.floor(from / env.hop)); i <= Math.min(env.rms.length - 1, Math.floor(to / env.hop)); i++) {
    run = (env.rms[i] ?? 0) < thr ? run + env.hop : 0;
    best = Math.max(best, run);
  }
  return best;
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** Same object back when nothing changed, so history and saves can skip no-ops. */
function finish(edit: Edit, cuts: Cut[]): Edit {
  const out = cuts.map((c) => (joinControls(c) ? { ...c, start: ms(c.start), end: ms(c.end) } : c));
  const same = out.length === edit.cuts.length && out.every((c, i) => JSON.stringify(c) === JSON.stringify(edit.cuts[i]));
  return same ? edit : { ...edit, cuts: out };
}
