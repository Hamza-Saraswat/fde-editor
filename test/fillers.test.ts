import { describe, expect, it } from "vitest";
import { findFillerCandidates } from "../src/transcribe/fillers.ts";
import { FillerCandidateSchema, type Span, type Word } from "../src/core/schema.ts";

const cfg = { edit: { fillerGapMs: 250 } };

let n = 0;
const w = (text: string, start: number, end: number, clipId = "c1"): Word => ({ id: `w${n++}`, clipId, text, start, end });

describe("findFillerCandidates", () => {
  it("flags filler tokens (after normalization) with their word id", () => {
    n = 0;
    const words = [w("So", 0, 0.2), w("Um,", 0.2, 0.4), w("this", 0.4, 0.6), w("uh", 0.6, 0.7), w("HMM...", 0.7, 0.9), w("umbrella", 0.9, 1.1)];
    const f = findFillerCandidates(words, [], cfg);
    expect(f).toEqual([
      { id: "f0", clipId: "c1", start: 0.2, end: 0.4, kind: "token", wordId: "w1" },
      { id: "f1", clipId: "c1", start: 0.6, end: 0.7, kind: "token", wordId: "w3" },
      { id: "f2", clipId: "c1", start: 0.7, end: 0.9, kind: "token", wordId: "w4" },
    ]);
    for (const c of f) expect(FillerCandidateSchema.parse(c)).toEqual(c);
  });

  it("flags a voiced gap (little detected silence) and skips a silent one", () => {
    n = 0;
    const words = [w("first", 0, 0.5), w("second", 1.0, 1.5), w("third", 2.0, 2.5), w("fourth", 3.0, 3.5)];
    const silences: Span[] = [
      { clipId: "c1", start: 1.55, end: 1.95 }, // 0.4 of the 0.5 s gap → silent pause, not a filler
      { clipId: "c1", start: 2.5, end: 2.6 }, // 0.1 of 0.5 = 20 % → still voiced
    ];
    const f = findFillerCandidates(words, silences, cfg);
    expect(f).toEqual([
      { id: "f0", clipId: "c1", start: 0.54, end: 0.96, kind: "gap", afterWordId: "w0" },
      { id: "f1", clipId: "c1", start: 2.54, end: 2.96, kind: "gap", afterWordId: "w2" },
    ]);
  });

  it("uses config.edit.fillerGapMs as an inclusive minimum", () => {
    n = 0;
    const words = [w("a", 0, 1), w("b", 1.25, 2), w("c", 2.2, 3)]; // gaps 0.25 and 0.2
    expect(findFillerCandidates(words, [], cfg).map((f) => f.afterWordId)).toEqual(["w0"]);
    expect(findFillerCandidates(words, [], { edit: { fillerGapMs: 300 } })).toEqual([]);
  });

  it("ignores gaps across clips and silences from other clips", () => {
    n = 0;
    const words = [w("end", 0, 0.5, "c1"), w("start", 5, 5.5, "c2"), w("next", 6, 6.5, "c2")];
    const silences: Span[] = [{ clipId: "c1", start: 5.5, end: 6 }]; // wrong clip: doesn't cover c2's gap
    const f = findFillerCandidates(words, silences, cfg);
    expect(f).toEqual([{ id: "f0", clipId: "c2", start: 5.54, end: 5.96, kind: "gap", afterWordId: "w1" }]);
  });

  it("numbers candidates by clip order, then time, mixing tokens and gaps", () => {
    n = 0;
    const words = [
      w("one", 0, 0.3, "c2"), w("um", 1, 1.2, "c2"),
      w("two", 0, 0.3, "c1"), w("three", 0.9, 1.1, "c1"), w("uh", 1.1, 1.3, "c1"),
    ];
    // clip order is the order clips first appear in `words` (c2 recorded first here)
    const f = findFillerCandidates(words, [], cfg);
    expect(f.map((c) => [c.id, c.clipId, c.kind, Math.round(c.start * 1000) / 1000])).toEqual([
      ["f0", "c2", "gap", 0.34],
      ["f1", "c2", "token", 1],
      ["f2", "c1", "gap", 0.34],
      ["f3", "c1", "token", 1.1],
    ]);
  });

  it("merges overlapping silence spans before measuring coverage", () => {
    n = 0;
    const words = [w("a", 0, 1), w("b", 2, 3)];
    const silences: Span[] = [
      { clipId: "c1", start: 1.0, end: 1.2 },
      { clipId: "c1", start: 1.1, end: 1.25 }, // overlaps: union is 0.25 of a 1 s gap → exactly 25 % → silent
    ];
    expect(findFillerCandidates(words, silences, cfg)).toEqual([]);
  });
});
