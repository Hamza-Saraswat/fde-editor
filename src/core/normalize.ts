// Word normalization shared by the script parser and the aligner, so "$20", "twenty dollars"
// and "20 dollars" all compare equal. Ported from BLAI_Full_Pipeline
// skills/elevenlabs-narration/scripts/qa_transcribe.py (normalize_words, spell_numbers).

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [[1_000_000_000_000, "trillion"], [1_000_000_000, "billion"], [1_000_000, "million"], [1000, "thousand"]];

export const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), "hundred", "thousand", "million", "billion", "trillion"]);

// Words Whisper-family models write for disfluencies. Matched after normalization.
export const FILLER_WORDS = new Set(["um", "umm", "uh", "uhh", "er", "erm", "ah", "ahh", "hmm", "mm", "mhm", "uhm"]);

function belowThousand(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    words.push(TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : ""));
  } else if (n > 0 || words.length === 0) {
    words.push(ONES[n]!);
  }
  return words.join(" ");
}

export function numberToWords(n: number): string {
  if (n < 0) return `minus ${numberToWords(-n)}`;
  // years and model numbers: "twenty twenty six"
  if (n >= 1100 && n <= 2099 && n % 100 !== 0 && !(n >= 2000 && n <= 2009)) {
    return `${belowThousand(Math.floor(n / 100))} ${belowThousand(n % 100)}`;
  }
  if (n < 1000) return belowThousand(n);
  const words: string[] = [];
  for (const [value, name] of SCALES) {
    if (n >= value) {
      words.push(`${belowThousand(Math.floor(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n) words.push(belowThousand(n));
  return words.join(" ");
}

export function spellNumbers(text: string): string {
  text = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  text = text.replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars ");
  text = text.replace(/%/g, " percent ");
  text = text.replace(/([a-zA-Z])(?=\d)/g, "$1 ");
  text = text.replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, frac: string) =>
    `${numberToWords(Number(whole))} point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`);
  text = text.replace(/(\d+)(?=[a-zA-Z])/g, "$1 ");
  return text.replace(/\d+/g, (m) => numberToWords(Number(m)));
}

function joinHyphens(text: string): string {
  // Hyphens become spaces on both the script and the transcript side, so "cross-functional",
  // "cross functional" and "forty-three" / "forty three" all compare equal.
  return text.replace(/\b([a-z]+)-([a-z]+)\b/g, "$1 $2");
}

/** Lowercase tokens with numbers spelled out, punctuation dropped, single-letter runs joined ("d g x" -> "dgx"). */
export function normalizeWords(text: string): string[] {
  let t = joinHyphens(text.toLowerCase().replace(/[’‘]/g, "'")).replace(/[-/–—]/g, " ");
  t = t.replace(/(\d)\s+\.(\d)/g, "$1.$2");
  t = t.replace(/\b(\d+)\.(\d+)\.(\d+)\b/g, "$1 point $2 point $3");
  t = spellNumbers(t);
  t = t.replace(/\bpoint oh\b/g, "point zero");
  t = t.replace(/[^a-z0-9' ]+/g, " ");
  const words = t.split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  return collapseLetterRuns(words.map((w) => ({ w, i: 0 }))).map((x) => x.w);
}

function collapseLetterRuns<T extends { w: string; i: number }>(words: T[]): T[] {
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ ...run[0]!, w: run.map((r) => r.w).join("") });
    else out.push(...run);
    run = [];
  };
  for (const x of words) {
    if (x.w.length === 1 && /[a-z]/.test(x.w)) run.push(x);
    else {
      flush();
      out.push(x);
    }
  }
  flush();
  return out;
}

export type Token = { token: string; wordIndex: number };

/**
 * Normalize a list of transcript words while remembering which word each token came from.
 * One word can become several tokens ("2026" -> "twenty twenty six"), and a run of
 * single-letter words collapses into one token mapped to the first of them.
 */
export function normalizeTranscriptWords(words: { text: string }[]): Token[] {
  const raw: { w: string; i: number }[] = [];
  words.forEach((word, i) => {
    for (const w of normalizeWords(word.text)) raw.push({ w, i });
  });
  return collapseLetterRuns(raw).map((x) => ({ token: x.w, wordIndex: x.i }));
}

export const isFillerWord = (text: string) => {
  const n = normalizeWords(text);
  return n.length === 1 && FILLER_WORDS.has(n[0]!);
};
