import { describe, expect, it } from "vitest";
import { alignScript, buildTokenStream, lcsRatio, sentenceTokens } from "../src/core/aligner.ts";
import { normalizeWords } from "../src/core/normalize.ts";
import { CandidatesSchema, type ScriptDoc, type Word } from "../src/core/schema.ts";

// ---------- helpers ----------

const S = [
  "Search AI engineer on LinkedIn right now, and you'll find two completely different jobs using the same title.",
  "One wants a developer who uses AI to write code faster.",
  "The other wants someone who can walk into a company, figure out where AI actually helps, and build it.",
  "Same title.",
  "Different job.",
  "And if you're trying to break into this field, chasing the wrong one is a great way to waste six months.",
];

function makeScript(texts: string[]): ScriptDoc {
  return {
    title: "test",
    sections: [{ id: "sec0", title: "t", level: 2, sentenceIds: texts.map((_, i) => `s${i + 1}`) }],
    sentences: texts.map((text, i) => ({ id: `s${i + 1}`, sectionId: "sec0", blockId: "b0.1", text, tokens: normalizeWords(text) })),
    cues: [],
  };
}

type Piece = { text: string; clipId?: string; tag?: string };

/** Words from spoken pieces; returns the words plus [firstWordId, lastWordId] per tag. */
function makeWords(pieces: Piece[]) {
  const words: Word[] = [];
  const ranges = new Map<string, [string, string]>();
  const clock = new Map<string, number>();
  for (const p of pieces) {
    const clipId = p.clipId ?? "c1";
    let t = clock.get(clipId) ?? 0;
    const first = words.length;
    for (const text of p.text.split(/\s+/).filter(Boolean)) {
      words.push({ id: `w${words.length}`, clipId, text, start: t, end: t + 0.25 });
      t += 0.3;
    }
    clock.set(clipId, t + 0.5);
    if (p.tag) ranges.set(p.tag, [words[first]!.id, words.at(-1)!.id]);
  }
  return { words, ranges };
}

const transcriptOf = (words: Word[]) => ({ words });

// ---------- tests ----------

describe("lcsRatio", () => {
  it("matches the difflib-style formula on simple cases", () => {
    expect(lcsRatio(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(lcsRatio(["a", "b", "c", "d"], ["a", "c", "d"])).toBeCloseTo(6 / 7);
    expect(lcsRatio(["a"], ["b"])).toBe(0);
  });
});

describe("alignScript", () => {
  it("(a) clean read: every sentence chosen, nothing missing, no ad-libs", () => {
    const { words, ranges } = makeWords(S.map((text, i) => ({ text, tag: `s${i + 1}` })));
    const c = alignScript(makeScript(S), transcriptOf(words));
    expect(CandidatesSchema.parse(c)).toEqual(c);
    expect(c.missing).toEqual([]);
    expect(c.adlibs).toEqual([]);
    for (const s of c.sentences) {
      expect(s.chosen).not.toBeNull();
      const occ = s.occurrences[s.chosen!]!;
      expect([occ.startWordId, occ.endWordId]).toEqual(ranges.get(s.sentenceId));
      expect(occ.score).toBe(1);
      expect(occ.clipId).toBe("c1");
    }
    // "Same title." is also said inside s1 — found, but the in-order path takes the real one
    const same = c.sentences.find((s) => s.sentenceId === "s4")!;
    expect(same.occurrences.length).toBe(2);
    expect(same.chosen).toBe(1);
  });

  it("(b) a flubbed first attempt and a retake: two occurrences, the later one chosen", () => {
    const { words, ranges } = makeWords([
      { text: S[0]! },
      { text: "One wants a coder who uses AI to write code", tag: "flub" },
      { text: S[1]!, tag: "retake" },
      ...S.slice(2).map((text) => ({ text })),
    ]);
    const c = alignScript(makeScript(S), transcriptOf(words));
    const s2 = c.sentences[1]!;
    expect(s2.occurrences.length).toBe(2);
    expect(s2.chosen).toBe(1);
    expect([s2.occurrences[0]!.startWordId, s2.occurrences[0]!.endWordId]).toEqual(ranges.get("flub"));
    expect([s2.occurrences[1]!.startWordId, s2.occurrences[1]!.endWordId]).toEqual(ranges.get("retake"));
    expect(s2.occurrences[0]!.score).toBeLessThan(s2.occurrences[1]!.score);
    expect(s2.occurrences[0]!.score).toBeGreaterThanOrEqual(0.6);
    expect(c.missing).toEqual([]);
    expect(c.adlibs).toEqual([]);
  });

  it("(b') two equally clean takes: the bonus picks the later one", () => {
    const { words } = makeWords([{ text: S[0]! }, { text: S[1]! }, { text: S[1]! }, { text: S[2]! }]);
    const c = alignScript(makeScript(S.slice(0, 3)), transcriptOf(words));
    expect(c.sentences[1]!.occurrences.length).toBe(2);
    expect(c.sentences[1]!.chosen).toBe(1);
  });

  it("(c) a skipped sentence is missing", () => {
    const { words } = makeWords(S.filter((_, i) => i !== 2).map((text) => ({ text })));
    const c = alignScript(makeScript(S), transcriptOf(words));
    expect(c.missing).toEqual(["s3"]);
    expect(c.sentences[2]!.chosen).toBeNull();
    expect(c.sentences.filter((s) => s.chosen !== null).length).toBe(S.length - 1);
  });

  it("(d) an inserted ad-lib becomes one ad-lib run", () => {
    const { words, ranges } = makeWords([
      { text: S[0]! },
      { text: S[1]! },
      { text: "seriously go grab yourself some coffee", tag: "adlib" },
      ...S.slice(2).map((text) => ({ text })),
    ]);
    const c = alignScript(makeScript(S), transcriptOf(words));
    const [start, end] = ranges.get("adlib")!;
    expect(c.adlibs).toEqual([{ clipId: "c1", startWordId: start, endWordId: end }]);
    expect(c.missing).toEqual([]);
  });

  it("(e) fillers inside a sentence don't break matching", () => {
    const { words, ranges } = makeWords([
      { text: S[0]! },
      { text: "Um, one wants a, uh, developer who um uses AI to write code faster.", tag: "s2" },
      ...S.slice(2).map((text) => ({ text })),
    ]);
    const c = alignScript(makeScript(S), transcriptOf(words));
    const s2 = c.sentences[1]!;
    expect(s2.chosen).toBe(0);
    expect(s2.occurrences[0]!.score).toBe(1);
    // the occurrence starts at the first real word, after the leading "Um,"
    const [first, last] = ranges.get("s2")!;
    expect(s2.occurrences[0]!.startWordId).toBe(`w${Number(first.slice(1)) + 1}`);
    expect(s2.occurrences[0]!.endWordId).toBe(last);
    expect(c.adlibs).toEqual([]);
  });

  it("(f) numbers: $20 in the script matches 'twenty dollars' and vice versa", () => {
    const script = makeScript(["It costs $20 a month to run in 2026.", "That's about twenty dollars a seat."]);
    const { words } = makeWords([
      { text: "It costs twenty dollars a month to run in twenty twenty six." },
      { text: "That's about $20 a seat." },
    ]);
    const c = alignScript(script, transcriptOf(words));
    expect(c.missing).toEqual([]);
    expect(c.sentences.map((s) => s.occurrences[s.chosen!]!.score)).toEqual([1, 1]);
    expect(c.adlibs).toEqual([]);
  });

  it("reports the exact LCS ratio of the matched window", () => {
    const { words } = makeWords([{ text: S[0]! }, { text: "One wants a coder who uses AI to write code" }]);
    const c = alignScript(makeScript(S.slice(0, 2)), transcriptOf(words));
    const occ = c.sentences[1]!.occurrences[0]!;
    const from = Number(occ.startWordId.slice(1));
    const to = Number(occ.endWordId.slice(1));
    const windowTokens = words.slice(from, to + 1).flatMap((w) => normalizeWords(w.text));
    const expected = lcsRatio(sentenceTokens(makeScript(S).sentences[1]!), windowTokens);
    expect(occ.score).toBeCloseTo(expected, 3);
  });

  it("keeps occurrences inside one clip and splits ad-lib runs at clip boundaries", () => {
    const { words } = makeWords([
      { text: S[0]!, clipId: "c1" },
      { text: "wait hold", clipId: "c1" },
      { text: "okay so", clipId: "c2" },
      { text: S[1]!, clipId: "c2" },
      { text: S[2]!, clipId: "c2" },
    ]);
    const c = alignScript(makeScript(S.slice(0, 3)), transcriptOf(words));
    expect(c.missing).toEqual([]);
    expect(c.adlibs).toEqual([]); // 2 + 2 uncovered words, never joined across the clip boundary
    expect(c.sentences[1]!.occurrences[0]!.clipId).toBe("c2");
    const clipOf = new Map(words.map((w) => [w.id, w.clipId]));
    for (const s of c.sentences) for (const o of s.occurrences) expect(clipOf.get(o.startWordId)).toBe(clipOf.get(o.endWordId));
  });

  it("finds an ad-lib split across clips only when each side has ≥ 3 words", () => {
    const { words } = makeWords([
      { text: S[0]!, clipId: "c1" },
      { text: "hang on one second", clipId: "c1" },
      { text: "right where was", clipId: "c2" },
      { text: S[1]!, clipId: "c2" },
    ]);
    const c = alignScript(makeScript(S.slice(0, 2)), transcriptOf(words));
    expect(c.adlibs.map((a) => a.clipId)).toEqual(["c1", "c2"]);
  });

  it("maps a collapsed letter run back to all of its words", () => {
    const stream = buildTokenStream([
      { text: "the", clipId: "c1" }, { text: "D", clipId: "c1" }, { text: "G", clipId: "c1" }, { text: "X", clipId: "c1" }, { text: "box", clipId: "c1" },
    ]);
    const dgx = stream.vocab.get("dgx")!;
    const pos = [...stream.ids].indexOf(dgx);
    expect([stream.firstWord[pos], stream.lastWord[pos]]).toEqual([1, 3]);
  });

  it("handles an empty transcript", () => {
    const c = alignScript(makeScript(S), { words: [] });
    expect(c.missing).toEqual(S.map((_, i) => `s${i + 1}`));
    expect(c.adlibs).toEqual([]);
  });

  it("perf: 300 sentences against ~5,000 words in under 3 s", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const syll = ["ka", "lo", "mi", "ne", "su", "ta", "ri", "po", "ve", "da", "go", "zu"];
    const vocab = Array.from({ length: 600 }, () => syll[Math.floor(rand() * 12)]! + syll[Math.floor(rand() * 12)]! + syll[Math.floor(rand() * 12)]!);
    const common = ["the", "a", "and", "to", "of", "it", "is", "you"];
    const texts = Array.from({ length: 300 }, () =>
      Array.from({ length: 10 + Math.floor(rand() * 8) }, () => (rand() < 0.3 ? common[Math.floor(rand() * common.length)]! : vocab[Math.floor(rand() * vocab.length)]!)).join(" "));
    const pieces: Piece[] = [];
    texts.forEach((text, i) => {
      if (i % 25 === 0) pieces.push({ text: text.split(" ").slice(0, 6).join(" ") }); // false start
      pieces.push({ text: i % 7 === 0 ? `um ${text}` : text });
    });
    const { words } = makeWords(pieces);
    while (words.length < 5000) words.push({ id: `w${words.length}`, clipId: "c1", text: vocab[Math.floor(rand() * vocab.length)]!, start: 9999, end: 9999 });
    expect(words.length).toBeGreaterThanOrEqual(5000);

    const t0 = performance.now();
    const c = alignScript(makeScript(texts), transcriptOf(words));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    expect(c.missing).toEqual([]);
  });
});
