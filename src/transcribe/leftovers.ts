// Listen-back check that every cut took. The edited audio is re-transcribed and lined up with the words
// the edit keeps. Words heard at a join that a cut there was meant to remove mean the cut chopped
// through speech: "is, you know, they" said as one run of sound, cut on the transcriber's stamps, keeps
// part of "you know" and garbles the join. Loudness can't find those (fast speech rarely has a quiet gap
// at a join, so most clean cuts look the same); hearing the words again can. Such cuts are turned off,
// which restores the words for a clean join; the review screen shows them and they can be turned back on.
// Pure.
import { FILLER_WORDS, normalizeWords } from "../core/normalize.ts";
import type { Edit, Timeline, Transcript } from "../core/schema.ts";
import { keptWordIds, wordToOutput } from "../core/timeline.ts";

type Tok = { t: string; start: number; end: number };

const tokensOf = (w: { text: string; start: number; end: number }): Tok[] =>
  normalizeWords(w.text).filter((t) => !FILLER_WORDS.has(t)).map((t) => ({ t, start: w.start, end: w.end }));

/** Levenshtein alignment of heard tokens to expected ones: true for each heard token that matched nothing. */
export function insertedTokens(expected: string[], heard: string[]): boolean[] {
  const n = expected.length, m = heard.length;
  const d = Array.from({ length: n + 1 }, (_, i) => new Int32Array(m + 1).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (expected[i - 1] === heard[j - 1] ? 0 : 1));
    }
  }
  const inserted = new Array<boolean>(m).fill(false);
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (expected[i - 1] === heard[j - 1] ? 0 : 1)) { i--; j--; }
    else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) i--;
    else { inserted[j - 1] = true; j--; }
  }
  return inserted;
}

export type Leftover = { cutId: string; heard: string; at: number }; // at = output seconds

/** Cuts whose words the re-listen still hears at their join. Never a cut the user made. */
export function findLeftovers(heard: { text: string; start: number; end: number }[], timeline: Timeline, transcript: Transcript, edit: Edit): Leftover[] {
  const kept = keptWordIds(edit, transcript);
  const expected: Tok[] = [];
  for (const w of transcript.words) {
    if (!kept.has(w.id)) continue;
    const at = wordToOutput(timeline, w);
    if (at) expected.push(...tokensOf({ text: w.text, ...at }));
  }
  expected.sort((a, b) => a.start - b.start);
  const got = heard.flatMap(tokensOf);
  const ins = insertedTokens(expected.map((x) => x.t), got.map((x) => x.t));

  // runs of consecutive inserted tokens
  const runs: Tok[][] = [];
  ins.forEach((isIns, j) => {
    if (!isIns) return;
    if (ins[j - 1]) runs.at(-1)!.push(got[j]!);
    else runs.push([got[j]!]);
  });

  const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;
  const out: Leftover[] = [];
  for (const run of runs) {
    if (run.length < 2) continue; // one stray word is as likely the recogniser as a leftover
    const from = run[0]!.start, to = run.at(-1)!.end;
    for (let i = 1; i < timeline.segments.length; i++) {
      const a = timeline.segments[i - 1]!, b = timeline.segments[i]!;
      if (a.clipId !== b.clipId || b.outStart < from - 0.35 || b.outStart > to + 0.35) continue;
      for (const c of edit.cuts) {
        if (!c.enabled || c.by === "user" || c.clipId !== a.clipId || c.end < a.end - 0.05 || c.start > b.start + 0.05) continue;
        const removed = transcript.words.filter((w) => w.clipId === c.clipId && mid(w) >= c.start && mid(w) <= c.end && !kept.has(w.id));
        const pool = removed.flatMap(tokensOf).map((x) => x.t);
        let hits = 0;
        for (const t of run) {
          const k = pool.indexOf(t.t);
          if (k >= 0) { hits++; pool.splice(k, 1); }
        }
        if (hits >= 2 && !out.some((o) => o.cutId === c.id)) out.push({ cutId: c.id, heard: run.map((x) => x.t).join(" "), at: b.outStart });
      }
    }
  }
  return out;
}
