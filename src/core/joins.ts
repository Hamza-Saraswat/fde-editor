// Join pass: where cuts land and whether they are worth making, the way dialogue editors work.
// - Cut a whole flub: a stumble or restart takes the "uh" next to it, or that "uh" gives the restart away.
// - Never orphan a word: a stumble cut keeps the last attempt at a script word, even when the transcriber
//   misheard it ("clod" for "Claude").
// - Never orphan a thought: a cut from a finished sentence into a lowercase word keeps the speaker's last
//   try at the sentence's opening; a word said on both sides of a cut ("task and | And just go") goes
//   with it.
// - Join in the quiet between words: cut edges move to the quietest point beside the stamp.
// - Natural keeps what a splice would make worse: a small stutter or filler next to running speech, a
//   short aside that runs straight into the next word, a slurred sentence ending. A cut that leaves
//   running speech keeps the restart's own pause, so the restart lands like a new sentence.
// - One cut per moment: two cuts closer than minSegmentMs leave a sliver of picture between two jumps,
//   so the smaller stutter gives way, or the two merge when nothing scripted sits between them.
// - Camera handling (from the clips' motion): a reach to the phone in a pause is cut, with a word or two
//   said during it; a reach to stop the recording during the last word holds the picture instead.
// Deterministic and reversible: every pass starts from what the planner decided (cut.wanted, cut.orig),
// so changing the style can always be undone. Pure, given the clips' loudness envelopes and motion.
import { valley, type Envelope } from "../media/energy.ts";
import { motionSpans, type Motion } from "../media/motion.ts";
import { isFillerWord, normalizeWords } from "./normalize.ts";
import type { Clip, Cut, Edit, ScriptDoc, Transcript, Word } from "./schema.ts";
import type { Style } from "./style.ts";
import { keptWordIds } from "./timeline.ts";

const ABSORB_GAP = 0.3; // a filler this close to a flub belongs to it
const SNAP_REACH = 0.12; // how far an edge may move to find the quiet between words
const QUIET_JOIN = 0.08; // this much quiet at a join counts as a pause
const SMALL_STUTTER = 0.6; // longer stumbles are cut even next to running speech (leaving them would be worse)
const SHORT_ASIDE = 1.0; // a content cut this short that runs straight into the next word isn't worth the splice
const CLUSTER_GIVE = 0.8; // of two cuts too close together, a stutter or filler this short gives way
const PLAY_PAD = 0.4; // most of a pause kept beside the words between two cuts
const REACH = { factor: 4, frames: 9, bridge: 0.6 }; // a hand on the camera: many times the usual motion, ≥ 0.3 s
const TAIL_STOP = 1.0; // a take stopped this soon after its last word: the reach to stop it starts in that word
export const BREATHE_MS = 250;
export const LEAD_IN_MS = 400; // a restart after a cut that leaves running speech keeps this much of its pause

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
const firstToken = (w: Word | undefined) => (w ? tokensOf(w)[0] : undefined);
const len = (c: Pick<Cut, "start" | "end">) => c.end - c.start;

export type JoinContext = {
  transcript: Transcript;
  script: ScriptDoc;
  envelopes: Map<string, Envelope>;
  style: Style;
  motion?: Map<string, Motion>; // clips without motion keep their camera-handling cuts and holds as they are
  clips?: Pick<Clip, "id" | "duration">[];
};

/** Cuts the join pass may change: not the user's, not pinned, not silence trims. */
export const joinControls = (c: Cut) => c.by !== "user" && !c.pinned && c.reason !== "user" && c.reason !== "silence";
/** Cuts made from the words (camera-handling cuts come from the picture and are rebuilt, not judged). */
const judged = (c: Cut) => joinControls(c) && c.reason !== "handling";

export function applyJoins(edit: Edit, ctx: JoinContext): Edit {
  const { transcript, script, envelopes, style } = ctx;
  const byClip = new Map<string, Word[]>();
  for (const w of transcript.words) (byClip.get(w.clipId) ?? byClip.set(w.clipId, []).get(w.clipId)!).push(w);
  for (const list of byClip.values()) list.sort((a, b) => a.start - b.start);
  const measured = (clipId: string) => !!ctx.motion?.has(clipId);

  // start from the planner's cuts; fillers keep what the edit style decided (applyStyle runs first);
  // camera-handling cuts are measured again below
  let cuts: Cut[] = edit.cuts.filter((c) => !(c.reason === "handling" && joinControls(c) && measured(c.clipId))).map((c) => {
    if (!judged(c)) return c;
    const wanted = c.wanted ?? c.enabled;
    const orig = c.orig ?? { start: c.start, end: c.end };
    const { breathe: _b, join: _j, ...rest } = c;
    return { ...rest, wanted, orig, start: orig.start, end: orig.end, enabled: c.reason === "filler" ? c.enabled : wanted };
  });
  const kept = keptWordIds({ ...edit, cuts }, transcript);
  const sentenceTokens = new Map(script.sentences.map((s) => [s.id, s.tokens]));
  const groupAt = (clipId: string, start: number, end: number) => edit.takeGroups.find((g) => {
    const o = g.options[g.chosen];
    return o && o.clipId === clipId && start >= o.start - 0.05 && end <= o.end + 0.05;
  });
  const takeOf = (c: Cut) => groupAt(c.clipId, c.start, c.end);
  const tokensIn = (g: ReturnType<typeof groupAt>) => new Set((g?.sentenceIds ?? []).flatMap((sid) => sentenceTokens.get(sid) ?? []));

  const absorbed = new Set<string>();
  cuts = cuts.map((c) => {
    if (!judged(c) || !c.enabled || c.reason === "filler" || c.reason === "adlib") return c;
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
      for (const t of tokensIn(g)) if (t.length >= 3 && !STOP.has(t)) script.add(skeleton(t));
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

  // 2b. never orphan the thought
  cuts = cuts.map((c) => {
    if (!judged(c) || !c.enabled || c.reason === "filler") return c;
    const words = byClip.get(c.clipId) ?? [];
    let { start, end } = c;
    const removed = () => words.filter((w) => mid(w) >= start && mid(w) <= end);
    const prev = [...words].reverse().find((w) => kept.has(w.id) && mid(w) < start);
    const next = words.find((w) => kept.has(w.id) && mid(w) > end);
    // the sentence after the cut keeps its opening: the removed words end with the last try at it
    const r = removed();
    if (prev && next && endsSentence(prev) && /^[a-z]/.test(next.text.trim()) && r.length >= 3) {
      const [k0, k1] = [firstToken(r[0]), firstToken(r[1])];
      for (let j = r.length - 2; j > 0 && k0 && k1; j--) {
        if (firstToken(r[j]) === k0 && firstToken(r[j + 1]) === k1) {
          end = Math.min(end, r[j]!.start);
          break;
        }
      }
    }
    // a word said on both sides of the cut goes with it
    const k = firstToken(prev);
    if (prev && next && k && k === firstToken(next) && tokensOf(prev).length === 1 && start - prev.end < ABSORB_GAP) start = Math.min(start, prev.start);
    if (end - start < 0.05) return { ...c, enabled: false };
    return start === c.start && end === c.end ? c : { ...c, start, end };
  });

  // 3. join in the quiet, 4. judge each join
  const keptNow = keptWordIds({ ...edit, cuts }, transcript);
  const gentle = style.disfluencies !== "clean";
  cuts = cuts.map((c) => {
    if (!judged(c) || !c.enabled) return c;
    const env = envelopes.get(c.clipId);
    const words = byClip.get(c.clipId) ?? [];
    const prev = [...words].reverse().find((w) => keptNow.has(w.id) && mid(w) < c.start);
    const next = words.find((w) => keptNow.has(w.id) && mid(w) > c.end);
    let { start, end } = c;
    if (env && c.reason !== "filler") {
      start = valley(env, Math.max(prev ? mid(prev) : start - SNAP_REACH, start - SNAP_REACH), Math.min(start + 0.04, end), start);
      end = valley(env, Math.max(end - 0.04, start + 0.02), Math.min(next ? mid(next) : end + SNAP_REACH, end + SNAP_REACH), end);
      // the valley is the centre of a 10 ms hop: never let it cross into a kept word's middle
      if (prev) start = Math.max(start, mid(prev) + 0.005);
      if (next) end = Math.min(end, mid(next) - 0.005);
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
    const off = { ...base, enabled: false };

    // a cut that leaves running speech: the restart keeps its own pause (a full beat before a new sentence)
    const leadIn = (b: Cut): Cut => {
      if (join.quietBefore || !join.quietAfter || !next || c.reason === "filler") return b;
      const ms = /^[A-Z]/.test(next.text.trim()) && !/^I\b/.test(next.text.trim()) ? LEAD_IN_MS : BREATHE_MS;
      const voicedTo = env ? quietFrom(env, removed.at(-1)?.end ?? b.start, next.start) : (removed.at(-1)?.end ?? b.start);
      return { ...b, end: Math.min(b.end, Math.max(voicedTo + 0.02, next.start - ms / 1000)), breathe: ms };
    };

    if (DISFLUENT.has(c.reason)) {
      const g = takeOf(c);
      const sentence = tokensIn(g);
      const removedTokens = removed.flatMap(tokensOf);
      // a correction: the cut words aren't in the script, and the next word brings the script's word in
      // their place ("about 50%, 15%" → the script says 15%)
      const correction = c.reason !== "filler" && removedTokens.some((t) => !sentence.has(t)) && !!next && tokensOf(next).some((t) => sentence.has(t) && !removedTokens.includes(t));
      if (!correction) {
        // a slurred sentence ending stays: trimming it leaves the sentence hanging mid-intonation
        if (c.reason !== "filler" && mismatch && removed.length && endsSentence(removed.at(-1)!)) return off;
        if (style.disfluencies === "light" && c.reason !== "filler") return off;
        // a small stutter that starts inside running speech, or a filler that runs into the next word:
        // the splice would be worse than the stutter
        const inFlow = !join.quietBefore || (c.reason === "filler" && !join.quietAfter);
        if (style.disfluencies === "natural" && inFlow && end - start <= SMALL_STUTTER) return off;
        return leadIn(base);
      }
    } else if (gentle && !join.quietAfter && end - start <= SHORT_ASIDE) {
      // a short aside running straight into the next word: cutting it leaves a clipped syllable
      return off;
    }
    // content cut (false start, aside, correction, long stumble)
    if (!join.quietBefore && join.quietAfter) return leadIn(base);
    return midFlow || mismatch ? { ...base, breathe: BREATHE_MS } : base;
  });

  // 5. one cut per moment (another take's removal counts as a cut too, one the pass can't move)
  for (let pass = 0; pass < 100; pass++) {
    const keptHere = keptWordIds({ ...edit, cuts }, transcript);
    const on = [...cuts.filter((c) => c.enabled && c.end > c.start), ...takeRemovals(byClip, keptHere, cuts)]
      .sort((a, b) => a.clipId.localeCompare(b.clipId) || a.start - b.start);
    let next: Cut[] | null = null;
    for (let i = 1; i < on.length && !next; i++) {
      const a = on[i - 1]!, b = on[i]!;
      if (a.clipId !== b.clipId || b.start - a.end <= 0.02) continue;
      const words = byClip.get(a.clipId) ?? [];
      const between = words.filter((w) => keptHere.has(w.id) && mid(w) > a.end && mid(w) < b.start);
      if (!between.length) continue; // nothing plays between them: they read as one cut
      // what plays between them: the words and a beat either side (a long pause there is trimmed away)
      const plays = Math.min(b.start, between.at(-1)!.end + PLAY_PAD) - Math.max(a.end, between[0]!.start - PLAY_PAD);
      if (plays * 1000 >= style.minSegmentMs) continue;
      const give = [a, b].filter((c) => judged(c) && DISFLUENT.has(c.reason) && len(c) <= CLUSTER_GIVE).sort((x, y) => len(x) - len(y))[0];
      if (give) {
        next = cuts.map((c) => (c.id === give.id ? { ...c, enabled: false } : c));
        break;
      }
      if (!judged(a) || !judged(b)) continue;
      const sentence = tokensIn(takeOf(b) ?? takeOf(a));
      const after = words.filter((w) => keptHere.has(w.id) && w.start >= b.end && w.start < b.end + 3).flatMap(tokensOf);
      const spare = between.every((w) => isFillerWord(w.text) || tokensOf(w).every((t) => !sentence.has(t) || after.includes(t)));
      if (spare) {
        const join = a.join && b.join ? { ...a.join, quietAfter: b.join.quietAfter } : a.join;
        next = cuts.map((c) => (c.id === a.id ? { ...c, end: b.end, join, ...(b.breathe ? { breathe: b.breathe } : {}) } : c.id === b.id ? { ...c, enabled: false } : c));
      }
    }
    if (!next) break;
    cuts = next;
  }

  // 6. camera handling, from the picture
  let holds = edit.holds;
  if (ctx.motion?.size) {
    const keptFinal = keptWordIds({ ...edit, cuts }, transcript);
    const ids = new Set(cuts.map((c) => c.id));
    holds = (edit.holds ?? []).filter((h) => !measured(h.clipId));
    for (const [clipId, m] of ctx.motion) {
      const words = (byClip.get(clipId) ?? []).filter((w) => keptFinal.has(w.id));
      if (!words.length) continue;
      const spans = motionSpans(m, REACH.factor, REACH.frames, REACH.bridge);
      const lastWord = words.at(-1)!;
      let holdFrom: number | null = null;
      for (const s of spans) {
        if (s.end <= words[0]!.start) continue; // before the take starts playing
        if (s.start >= lastWord.start - 0.2) {
          holdFrom ??= Math.max(lastWord.start, s.start); // reaching to stop the recording
          continue;
        }
        let from = s.start, to = s.end;
        const over = words.filter((w) => w.end > from && w.start < to);
        if (over.length) {
          // a word or two said during the reach, on its own between pauses, goes with it
          const i0 = words.indexOf(over[0]!), i1 = words.indexOf(over.at(-1)!);
          const before = words[i0 - 1], after = words[i1 + 1];
          const alone = over.length <= 2 && (!before || over[0]!.start - before.end >= 0.3) && (!after || after.start - over.at(-1)!.end >= 0.3);
          if (!alone) continue; // a gesture while talking
          from = Math.min(from, over[0]!.start - 0.25);
          to = Math.max(to, over.at(-1)!.end);
        }
        const prev = [...words].reverse().find((w) => w.end <= from + 1e-6 && !over.includes(w));
        const nxt = words.find((w) => w.start >= to - 1e-6 && !over.includes(w));
        if (!prev || !nxt) continue;
        from = Math.max(from - 0.05, prev.end + 0.05);
        to = Math.min(to + 0.05, nxt.start - 0.05);
        const id = `kh-${clipId}-${Math.round(s.start * 1000)}`;
        if (to - from < 0.1 || ids.has(id)) continue;
        // already a cut between those words (another take, a false start): the reach goes with it
        const allWords = byClip.get(clipId) ?? [];
        if (allWords.some((w) => !keptFinal.has(w.id) && w.start >= prev.end - 0.01 && w.end <= nxt.start + 0.01)) continue;
        if (cuts.some((c) => c.enabled && c.clipId === clipId && c.start < nxt.start && c.end > prev.end)) continue;
        cuts.push({ id, clipId, start: from, end: to, reason: "handling", by: "auto", enabled: true, breathe: LEAD_IN_MS, note: "Hand on the camera" });
      }
      const dur = ctx.clips?.find((c) => c.id === clipId)?.duration;
      if (dur !== undefined && dur - lastWord.end < TAIL_STOP) holdFrom = Math.min(holdFrom ?? Infinity, mid(lastWord));
      if (holdFrom !== null && dur !== undefined && holdFrom < dur) holds.push({ clipId, start: ms(holdFrom), end: ms(dur) });
    }
  }
  return finish(edit, cuts, holds);
}

/** Stretches of removed words no enabled cut covers (other takes), as fixed pseudo-cuts. */
function takeRemovals(byClip: Map<string, Word[]>, kept: Set<string>, cuts: Cut[]): Cut[] {
  const out: Cut[] = [];
  for (const [clipId, words] of byClip) {
    const cut = (w: Word) => cuts.some((c) => c.enabled && c.clipId === clipId && mid(w) >= c.start && mid(w) <= c.end);
    let run: Word[] = [];
    const flush = () => {
      if (run.length) out.push({ id: `take:${run[0]!.id}`, clipId, start: run[0]!.start, end: run.at(-1)!.end, reason: "user", by: "user", enabled: true });
      run = [];
    };
    for (const w of words) {
      if (!kept.has(w.id) && !cut(w)) run.push(w);
      else flush();
    }
    flush();
  }
  return out;
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

/** Where the sound that runs through `from` falls quiet for 30 ms (no later than `limit`). */
function quietFrom(env: Envelope, from: number, limit: number): number {
  const thr = Math.max(0.004, env.speech * 0.2);
  let run = 0;
  for (let i = Math.max(0, Math.floor(from / env.hop)); i * env.hop < limit && i < env.rms.length; i++) {
    run = (env.rms[i] ?? 0) < thr ? run + 1 : 0;
    if (run >= 3) return (i - 2) * env.hop;
  }
  return Math.min(from, limit);
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** Same object back when nothing changed, so history and saves can skip no-ops. */
function finish(edit: Edit, cuts: Cut[], holds: Edit["holds"]): Edit {
  const out = cuts.map((c) => (joinControls(c) ? { ...c, start: ms(c.start), end: ms(c.end) } : c));
  const sameCuts = out.length === edit.cuts.length && out.every((c, i) => JSON.stringify(c) === JSON.stringify(edit.cuts[i]));
  const sameHolds = JSON.stringify(holds ?? []) === JSON.stringify(edit.holds ?? []);
  if (sameCuts && sameHolds) return edit;
  const { holds: _h, ...rest } = edit;
  return { ...rest, cuts: out, ...(holds?.length ? { holds } : {}) };
}
