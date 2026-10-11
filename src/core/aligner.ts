// Script ↔ transcript alignment: where was each script sentence spoken (every take of it), which take
// sits on the best in-order path, which sentences were never said, and which stretches of speech
// aren't in the script at all (ad-libs).
//
// Similarity metric: token-level LCS ratio, 2·LCS(a, b) / (|a| + |b|). It's the same formula as
// difflib's SequenceMatcher.ratio() with autojunk off, but computed with an optimal LCS instead of
// difflib's greedy matching blocks (so it's ≥ difflib's value, symmetric, and exact).
//
// Finding occurrences without trying every window: for each sentence S (length L) one semi-global
// DP pass over the transcript token stream (Sellers' algorithm with indel costs) gives, for every end
// position e, the start b that minimizes the indel distance D = L + W − 2·LCS between S and T[b..e]
// (ties → the longer window, which has more matches). The window's score is then exactly
// 1 − D / (L + W) = the LCS ratio. That's O(L·N) per sentence — O(script tokens × transcript tokens)
// overall, ~7.5M cell updates for 1,500 × 5,000 — instead of O(N·L³) for explicit sliding windows.
// The ≥ 0.6 threshold bounds the window length implicitly (≈ 0.43·L … 2.33·L), which still admits
// takes that were cut short. Candidate windows are then picked greedily by score, non-overlapping per
// sentence (= local maxima), and must match at least min(L, 2) tokens (L ≤ 3, which also needs
// score ≥ 0.8) or 3 tokens (longer sentences).
//
// Best path: weighted chain DP. Choose ≤ 1 occurrence per sentence so chosen windows strictly
// increase in transcript position in script order, maximizing Σ (score + retake bonus) · L. The bonus
// (up to +0.05 for the last of several occurrences) breaks near-ties toward the later take. Processed
// sentence by sentence with a Fenwick tree of prefix maxima keyed by window end: O(K log N).
import { FILLER_WORDS, normalizeTranscriptWords, normalizeWords } from "./normalize.ts";
import type { Candidates, Occurrence, ScriptDoc, Sentence, Transcript, Word } from "./schema.ts";

export const MIN_SCORE = 0.6;
export const MIN_SCORE_SHORT = 0.8;
export const SHORT_SENTENCE_TOKENS = 3;
export const RETAKE_BONUS = 0.05;
export const MIN_ADLIB_WORDS = 3;

/** Transcript tokens with fillers removed, as integer ids, mapped back to words. */
export type TokenStream = {
  ids: Int32Array;
  firstWord: Int32Array; // word index each token comes from
  lastWord: Int32Array; // differs from firstWord only for collapsed letter runs ("D G X" -> "dgx")
  segments: { start: number; end: number }[]; // [start, end) token ranges, one per contiguous clip
  vocab: Map<string, number>;
  contentWord: Uint8Array; // per word: 1 if it produced at least one non-filler token
};

/** A window [b, e] (inclusive token positions) of the stream. */
export type Match = { b: number; e: number; score: number; matched: number };

const isSingleLetterWord = (text: string) => {
  const n = normalizeWords(text);
  return n.length === 1 && n[0]!.length === 1;
};

export function buildTokenStream(words: Pick<Word, "text" | "clipId">[]): TokenStream {
  const all = normalizeTranscriptWords(words);
  const vocab = new Map<string, number>();
  const ids: number[] = [];
  const firstWord: number[] = [];
  const lastWord: number[] = [];
  const segments: { start: number; end: number }[] = [];
  const contentWord = new Uint8Array(words.length);
  for (let k = 0; k < all.length; k++) {
    const { token, wordIndex } = all[k]!;
    if (FILLER_WORDS.has(token)) continue;
    let id = vocab.get(token);
    if (id === undefined) vocab.set(token, (id = vocab.size));
    let end = wordIndex;
    const nextWord = all[k + 1]?.wordIndex ?? words.length;
    if (token.length > 1 && nextWord > wordIndex + 1 && isSingleLetterWord(words[wordIndex]!.text)) end = nextWord - 1;
    for (let w = wordIndex; w <= end; w++) contentWord[w] = 1;

    const pos = ids.length;
    const clipId = words[wordIndex]!.clipId;
    const seg = segments.at(-1);
    if (!seg || words[firstWord[seg.start]!]!.clipId !== clipId) segments.push({ start: pos, end: pos + 1 });
    else seg.end = pos + 1;
    ids.push(id);
    firstWord.push(wordIndex);
    lastWord.push(end);
  }
  return {
    ids: Int32Array.from(ids),
    firstWord: Int32Array.from(firstWord),
    lastWord: Int32Array.from(lastWord),
    segments,
    vocab,
    contentWord,
  };
}

/** Normalized, filler-free tokens of a script sentence (falls back to its text if tokens are empty). */
export function sentenceTokens(s: Pick<Sentence, "text" | "tokens">): string[] {
  const toks = s.tokens.length ? s.tokens.flatMap((t) => normalizeWords(t)) : normalizeWords(s.text);
  return toks.filter((t) => !FILLER_WORDS.has(t));
}

/** Exact token-level LCS ratio 2·LCS/(|a|+|b|) — the score reported for every occurrence. */
export function lcsRatio(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 1;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[b.length]!) / (a.length + b.length);
}

/** All non-overlapping fuzzy occurrences of sentence `S` (token ids) in the stream, in recording order. */
export function findOccurrences(S: Int32Array, stream: TokenStream): Match[] {
  const L = S.length;
  if (L === 0) return [];
  const short = L <= SHORT_SENTENCE_TOKENS;
  const threshold = short ? MIN_SCORE_SHORT : MIN_SCORE;
  const minMatched = short ? Math.min(L, 2) : 3;
  const ids = stream.ids;

  // Column DP over transcript positions. D[i] = min indel distance between S[0..i) and some window
  // T[b..e]; B[i] = that window's start b (ties → smaller b).
  let prevD = new Int32Array(L + 1);
  let prevB = new Int32Array(L + 1);
  let curD = new Int32Array(L + 1);
  let curB = new Int32Array(L + 1);
  const cands: Match[] = [];

  for (const seg of stream.segments) {
    for (let i = 0; i <= L; i++) {
      prevD[i] = i;
      prevB[i] = seg.start;
    }
    for (let e = seg.start; e < seg.end; e++) {
      const t = ids[e]!;
      curD[0] = 0;
      curB[0] = e + 1;
      for (let i = 1; i <= L; i++) {
        // T[e] is an extra word in the take
        let d = prevD[i]! + 1;
        let b = prevB[i]!;
        // S[i-1] wasn't said
        const d2 = curD[i - 1]! + 1;
        const b2 = curB[i - 1]!;
        if (d2 < d || (d2 === d && b2 < b)) {
          d = d2;
          b = b2;
        }
        // match
        if (S[i - 1] === t) {
          const d3 = prevD[i - 1]!;
          const b3 = prevB[i - 1]!;
          if (d3 < d || (d3 === d && b3 < b)) {
            d = d3;
            b = b3;
          }
        }
        curD[i] = d;
        curB[i] = b;
      }
      const D = curD[L]!;
      const b = curB[L]!;
      const W = e - b + 1;
      if (W > 0) {
        const score = 1 - D / (L + W);
        const matched = (L + W - D) / 2;
        if (score >= threshold - 1e-9 && matched >= minMatched) cands.push({ b, e, score, matched });
      }
      [prevD, curD] = [curD, prevD];
      [prevB, curB] = [curB, prevB];
    }
  }

  // local maxima: best first, no overlaps
  cands.sort((x, y) => y.score - x.score || y.matched - x.matched || x.b - y.b);
  const picked: Match[] = [];
  for (const c of cands) {
    if (picked.some((p) => c.b <= p.e && p.b <= c.e)) continue;
    picked.push(c);
  }
  return picked.sort((x, y) => x.b - y.b);
}

type PathNode = { sentence: number; occ: number; total: number; prev: PathNode | null };

/**
 * Best monotonic path: at most one occurrence per sentence, strictly increasing in transcript position
 * in script order, maximizing Σ (score + bonus) · weight. Returns the chosen occurrence index per
 * sentence (or null). `weights` defaults to 1 per sentence.
 */
export function bestPath(occs: Match[][], streamLength: number, weights?: number[]): (number | null)[] {
  const n = Math.max(1, streamLength);
  const tree: (PathNode | null)[] = new Array(n + 1).fill(null);
  const update = (pos: number, node: PathNode) => {
    for (let i = pos + 1; i <= n; i += i & -i) {
      const cur = tree[i];
      if (!cur || node.total > cur.total) tree[i] = node;
    }
  };
  const query = (pos: number): PathNode | null => {
    let best: PathNode | null = null;
    for (let i = Math.min(pos, n - 1) + 1; i > 0; i -= i & -i) {
      const cur = tree[i];
      if (cur && (!best || cur.total > best.total)) best = cur;
    }
    return best;
  };

  occs.forEach((list, s) => {
    const weight = weights?.[s] ?? 1;
    // query everything first so two takes of the same sentence never chain
    const nodes = list.map((o, k) => {
      const bonus = list.length > 1 ? (RETAKE_BONUS * k) / (list.length - 1) : 0;
      const before = o.b > 0 ? query(o.b - 1) : null;
      return { e: o.e, node: { sentence: s, occ: k, total: (o.score + bonus) * weight + (before?.total ?? 0), prev: before } };
    });
    for (const { e, node } of nodes) update(e, node);
  });

  const chosen: (number | null)[] = occs.map(() => null);
  for (let node = query(n - 1); node; node = node.prev) chosen[node.sentence] = node.occ;
  return chosen;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function alignScript(script: ScriptDoc, transcript: Pick<Transcript, "words">): Candidates {
  const words = transcript.words;
  const stream = buildTokenStream(words);
  const sentenceIds = script.sentences.map((s) =>
    Int32Array.from(sentenceTokens(s), (t) => stream.vocab.get(t) ?? -1));

  const matches = sentenceIds.map((S) => findOccurrences(S, stream));
  const chosen = bestPath(matches, stream.ids.length, sentenceIds.map((S) => S.length));

  const toOccurrence = (m: Match): Occurrence => {
    const first = words[stream.firstWord[m.b]!]!;
    const last = words[stream.lastWord[m.e]!]!;
    return { clipId: first.clipId, startWordId: first.id, endWordId: last.id, score: round3(m.score) };
  };

  // ad-libs: runs of words not covered by ANY occurrence of ANY sentence
  const covered = new Uint8Array(words.length);
  for (const list of matches) {
    for (const m of list) {
      for (let w = stream.firstWord[m.b]!; w <= stream.lastWord[m.e]!; w++) covered[w] = 1;
    }
  }
  const adlibs: Candidates["adlibs"] = [];
  let run: number[] = [];
  const flush = () => {
    const content = run.filter((i) => stream.contentWord[i]);
    if (content.length >= MIN_ADLIB_WORDS) {
      const first = words[content[0]!]!;
      adlibs.push({ clipId: first.clipId, startWordId: first.id, endWordId: words[content.at(-1)!]!.id });
    }
    run = [];
  };
  for (let i = 0; i < words.length; i++) {
    if (run.length && words[i]!.clipId !== words[run[0]!]!.clipId) flush();
    if (covered[i]) flush();
    else run.push(i);
  }
  flush();

  const sentences = script.sentences.map((s, i) => ({
    sentenceId: s.id,
    occurrences: matches[i]!.map(toOccurrence),
    chosen: chosen[i] ?? null,
  }));
  return {
    sentences,
    adlibs,
    missing: sentences.filter((s) => s.chosen === null).map((s) => s.sentenceId),
  };
}
