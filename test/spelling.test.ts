import { describe, expect, it } from "vitest";
import type { Edit, ScriptDoc, Transcript } from "../src/core/schema.ts";
import { alignSpelling, lcsPairs, scriptSpellingMap } from "../src/pipeline/spelling.ts";
import { srtFromTimeline } from "../src/media/sidecars.ts";

const words = (texts: string[], clipId = "c1", t0 = 0, first = 0) =>
  texts.map((text, i) => ({ id: `w${first + i}`, clipId, text, start: t0 + i * 0.5, end: t0 + i * 0.5 + 0.4 }));

const map = (scriptText: string, spoken: string[]) => {
  const m = new Map<string, string>();
  alignSpelling(scriptText.split(/\s+/), words(spoken), m);
  return m;
};

describe("lcsPairs", () => {
  it("returns an optimal common subsequence in order", () => {
    expect(lcsPairs(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toEqual([[0, 0], [2, 2], [3, 3]]);
    expect(lcsPairs([], ["a"])).toEqual([]);
  });
});

describe("alignSpelling", () => {
  it('maps "twenty dollars" to "$20" and merges the second word', () => {
    const m = map("It costs $20.", ["it", "costs", "twenty", "dollars"]);
    expect(m.get("w2")).toBe("$20.");
    expect(m.get("w3")).toBe("");
    expect(m.get("w0")).toBe("It");
  });

  it('joins script words when one spoken word covers them ("$20" spoken, "twenty dollars" scripted)', () => {
    const m = map("It costs twenty dollars.", ["It", "costs", "$20"]);
    expect(m.get("w2")).toBe("twenty dollars.");
  });

  it("keeps the script's punctuation and case", () => {
    const m = map("Same title. Different job.", ["same", "title", "different", "job"]);
    expect([...m.entries()]).toEqual([["w0", "Same"], ["w1", "title."], ["w2", "Different"], ["w3", "job."]]);
  });

  it("leaves unmatched spoken words out of the map", () => {
    const m = map("It costs $20.", ["It", "really", "uh", "costs", "twenty", "dollars"]);
    expect(m.has("w1")).toBe(false); // ad-libbed "really"
    expect(m.has("w2")).toBe(false); // filler
    expect(m.get("w3")).toBe("costs");
    expect(m.get("w4")).toBe("$20.");
  });

  it("does not map a script word that was only partly spoken", () => {
    const m = map("It costs $20.", ["it", "costs", "twenty", "bucks"]);
    expect(m.has("w2")).toBe(false);
    expect(m.has("w3")).toBe(false);
    expect(m.get("w1")).toBe("costs");
  });

  it("handles letter runs spread over several spoken words", () => {
    const m = map("The DGX Spark is small.", ["the", "D", "G", "X", "spark", "is", "small"]);
    expect(m.get("w1")).toBe("DGX");
    expect(m.get("w2")).toBe("");
    expect(m.get("w3")).toBe("");
    expect(m.get("w4")).toBe("Spark");
  });
});

describe("scriptSpellingMap", () => {
  const script: ScriptDoc = {
    title: "T",
    sections: [{ id: "sec0", title: "S", level: 2, sentenceIds: ["s0.1", "s0.2"] }],
    sentences: [
      { id: "s0.1", sectionId: "sec0", blockId: "b0.1", text: "It costs $20.", tokens: ["it", "costs", "twenty", "dollars"] },
      { id: "s0.2", sectionId: "sec0", blockId: "b0.1", text: "Same title.", tokens: ["same", "title"] },
    ],
    cues: [],
  };
  // take 1 of s0.1 (w0–w3), a retake (w4–w7), then s0.2 (w8–w9)
  const transcript: Transcript = {
    engine: "test", model: "test", silences: [], fillers: [],
    words: words(["it", "costs", "twenty", "bucks", "it", "costs", "twenty", "dollars", "same", "title"]),
  };
  const opt = (a: number, b: number) => ({
    startWordId: `w${a}`, endWordId: `w${b}`, clipId: "c1", start: transcript.words[a]!.start, end: transcript.words[b]!.end,
  });
  const edit: Edit = {
    version: 1, clipOrder: ["c1"], cuts: [], overlays: [], chapters: [], intro: false, outro: false,
    takeGroups: [
      { id: "tg1", sentenceIds: ["s0.1"], options: [opt(0, 3), opt(4, 7)], chosen: 1, why: "" },
      { id: "tg2", sentenceIds: ["s0.2"], options: [opt(8, 9)], chosen: 0, why: "" },
    ],
  };

  it("uses only each group's chosen take", () => {
    const m = scriptSpellingMap(script, transcript, edit);
    expect(m.has("w2")).toBe(false); // unchosen take
    expect(m.get("w6")).toBe("$20.");
    expect(m.get("w7")).toBe("");
    expect(m.get("w8")).toBe("Same");
    expect(m.get("w9")).toBe("title.");
  });

  it("feeds srtFromTimeline: the merged word disappears and the script spelling shows", () => {
    const m = scriptSpellingMap(script, transcript, edit);
    const kept = transcript.words.slice(4);
    const timeline = { fps: 30, segments: [{ clipId: "c1", start: 2, end: 5, frames: 90, outStart: 0 }], duration: 3, overlays: [], chapters: [] };
    const srt = srtFromTimeline(kept, timeline, 0, m);
    expect(srt).toContain("It costs $20.");
    expect(srt).toContain("Same title.");
    expect(srt).not.toContain("dollars");
  });
});
