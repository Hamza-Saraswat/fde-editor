// Script spelling for captions: the transcript says "twenty dollars", the script says "$20". For every
// take group's chosen take, align the spoken words against the script sentence(s) with a token-level
// LCS on normalized forms and map each matched transcript word to the script's spelling (with its
// punctuation and case). When one script word was spoken as several transcript words, the first gets
// the script word and the rest get "" (srtFromTimeline merges "" into the previous word); when one
// transcript word covers several script words, it gets them all joined by spaces.
// Only clean correspondences are mapped: every token of the script word and of each transcript word
// involved must be matched, contiguously. Anything else keeps the transcript's own text.
import { FILLER_WORDS, normalizeTranscriptWords, normalizeWords } from "../core/normalize.ts";
import type { Edit, ScriptDoc, Transcript, Word } from "../core/schema.ts";
import { indexWords, wordsInRange } from "../core/timeline.ts";

type ScriptTok = { token: string; word: number };
type SpokenTok = { token: string; first: number; last: number }; // word index range the token came from

const isSingleLetterWord = (text: string) => {
  const n = normalizeWords(text);
  return n.length === 1 && n[0]!.length === 1;
};

/** Transcript tokens (fillers dropped) with the words each came from; a collapsed letter run ("D G X") spans several words. */
function spokenTokens(words: Pick<Word, "text">[]): SpokenTok[] {
  const all = normalizeTranscriptWords(words);
  const out: SpokenTok[] = [];
  all.forEach(({ token, wordIndex }, k) => {
    let last = wordIndex;
    const next = all[k + 1]?.wordIndex ?? words.length;
    if (token.length > 1 && next > wordIndex + 1 && isSingleLetterWord(words[wordIndex]!.text)) last = next - 1;
    if (!FILLER_WORDS.has(token)) out.push({ token, first: wordIndex, last });
  });
  return out;
}

/** Matched (scriptIndex, spokenIndex) pairs of a longest common subsequence, ascending. */
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Map spoken words to the script's spelling of the same words; adds to `map`. */
export function alignSpelling(scriptWords: string[], words: Pick<Word, "id" | "text">[], map: Map<string, string>): void {
  const sTok: ScriptTok[] = [];
  const sCount = new Array<number>(scriptWords.length).fill(0);
  scriptWords.forEach((sw, j) => {
    for (const token of normalizeWords(sw)) {
      if (FILLER_WORDS.has(token)) continue;
      sTok.push({ token, word: j });
      sCount[j]!++;
    }
  });
  const tTok = spokenTokens(words);
  if (!sTok.length || !tTok.length) return;

  const sMatch = new Array<number>(sTok.length).fill(-1);
  const tMatched = new Array<boolean>(tTok.length).fill(false);
  for (const [si, ti] of lcsPairs(sTok.map((t) => t.token), tTok.map((t) => t.token))) {
    sMatch[si] = ti;
    tMatched[ti] = true;
  }

  // a spoken word is usable only when every token it produced was matched
  const wordTokens = new Map<number, number[]>();
  tTok.forEach((t, ti) => {
    for (let wi = t.first; wi <= t.last; wi++) wordTokens.set(wi, [...(wordTokens.get(wi) ?? []), ti]);
  });
  const fullyMatched = (wi: number) => (wordTokens.get(wi) ?? []).every((ti) => tMatched[ti]);

  let si = 0;
  for (let j = 0; j < scriptWords.length; j++) {
    const tis = sMatch.slice(si, si + sCount[j]!);
    si += sCount[j]!;
    if (!tis.length || tis.some((ti) => ti < 0)) continue;
    if (tis.some((ti, k) => k > 0 && ti !== tis[k - 1]! + 1)) continue; // must be contiguous in the speech
    const wis: number[] = [];
    for (const ti of tis) {
      for (let wi = tTok[ti]!.first; wi <= tTok[ti]!.last; wi++) if (!wis.includes(wi)) wis.push(wi);
    }
    if (!wis.every(fullyMatched)) continue;
    const [head, ...rest] = wis.map((wi) => words[wi]!.id);
    const existing = map.get(head!);
    if (existing === undefined) map.set(head!, scriptWords[j]!);
    else if (existing !== "") map.set(head!, `${existing} ${scriptWords[j]}`);
    for (const id of rest) if (!map.get(id)) map.set(id, "");
  }
}

/** wordId → the script's spelling of that word ("" = merge into the previous caption word). */
export function scriptSpellingMap(script: ScriptDoc, transcript: Transcript, edit: Edit): Map<string, string> {
  const map = new Map<string, string>();
  const idx = indexWords(transcript);
  const sentences = new Map(script.sentences.map((s) => [s.id, s]));
  for (const g of edit.takeGroups) {
    const opt = g.options[g.chosen];
    if (!opt) continue;
    const words = wordsInRange(idx, opt.startWordId, opt.endWordId)
      ?? (idx.byClip.get(opt.clipId) ?? []).filter((w) => (w.start + w.end) / 2 >= opt.start && (w.start + w.end) / 2 <= opt.end);
    const scriptWords = g.sentenceIds.flatMap((id) => sentences.get(id)?.text.split(/\s+/).filter(Boolean) ?? []);
    alignSpelling(scriptWords, words, map);
  }
  return map;
}
