import { describe, expect, it } from "vitest";
import { chapterTitle, planToEdit } from "../src/core/compiler.ts";
import {
  ConfigSchema, EditSchema, type Candidates, type Clip, type Cut, type Edit, type EditPlan, type ScriptDoc, type Transcript, type Word,
} from "../src/core/schema.ts";
import { buildTimeline, keptWordIds } from "../src/core/timeline.ts";

// A two-clip recording of a three-sentence script:
//   c1: "okay rolling" | flubbed s0.1 | "let me redo" | s0.1 | um | s0.2 | (voiced gap) | s1.1 | ad-lib | "cut there"
//   c2: a retake of s1.1, which the plan picks. The project lists c2 first.
const W: [string, string, number, number][] = [
  ["c1", "okay", 0.5, 0.8], ["c1", "rolling", 0.85, 1.2], // w0 w1  head chatter
  ["c1", "Hello", 2.0, 2.3], ["c1", "word", 2.35, 2.7], // w2 w3  flubbed s0.1
  ["c1", "let", 3.0, 3.2], ["c1", "me", 3.25, 3.4], ["c1", "redo", 3.45, 3.8], // w4–w6 chatter
  ["c1", "Hello", 4.5, 4.8], ["c1", "world.", 4.85, 5.2], // w7 w8  s0.1
  ["c1", "um", 5.4, 5.6], // w9 filler token f0
  ["c1", "This", 5.8, 6.0], ["c1", "is", 6.05, 6.2], ["c1", "a", 6.25, 6.3], ["c1", "test.", 6.35, 6.7], // w10–w13 s0.2
  ["c1", "Next", 7.5, 7.8], ["c1", "part", 7.85, 8.1], ["c1", "here.", 8.15, 8.5], // w14–w16 s1.1 (first try)
  ["c1", "nice", 8.9, 9.2], ["c1", "one", 9.25, 9.5], // w17 w18 ad-lib
  ["c1", "cut", 11.0, 11.3], ["c1", "there", 11.35, 11.6], // w19 w20 tail chatter
  ["c2", "Next", 1.0, 1.3], ["c2", "part", 1.35, 1.6], ["c2", "here.", 1.65, 2.0], // w21–w23 s1.1 retake
];
const words: Word[] = W.map(([clipId, text, start, end], i) => ({ id: `w${i}`, clipId, text, start, end }));

const transcript: Transcript = {
  engine: "test", model: "test", words, silences: [],
  fillers: [
    { id: "f0", clipId: "c1", start: 5.4, end: 5.6, kind: "token", wordId: "w9" },
    { id: "f1", clipId: "c1", start: 6.8, end: 7.3, kind: "gap", afterWordId: "w13" },
    { id: "f2", clipId: "c1", start: 0.85, end: 1.0, kind: "gap", afterWordId: "w0" }, // inside the head trim
  ],
};

const clip = (id: string, duration: number): Clip => ({
  id, name: id, path: `/x/${id}.mov`, duration, width: 2560, height: 1440, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false,
});
const clips = [clip("c2", 3), clip("c1", 13)];

const script: ScriptDoc = {
  title: "Test video",
  sections: [
    { id: "sec0", title: "Cold open (0:00–0:40)", level: 2, sentenceIds: ["s0.1", "s0.2"] },
    { id: "sec1", title: "1. The next part (0:40–2:00)", level: 2, sentenceIds: [] },
    { id: "sec2", title: "Type 1", level: 3, sentenceIds: ["s1.1"] },
    { id: "sec3", title: "Never recorded", level: 2, sentenceIds: ["s2.1"] },
  ],
  sentences: [
    { id: "s0.1", sectionId: "sec0", blockId: "b0.1", text: "Hello world.", tokens: ["hello", "world"] },
    { id: "s0.2", sectionId: "sec0", blockId: "b0.1", text: "This is a test.", tokens: ["this", "is", "a", "test"] },
    { id: "s1.1", sectionId: "sec2", blockId: "b2.1", text: "Next part here.", tokens: ["next", "part", "here"] },
    { id: "s2.1", sectionId: "sec3", blockId: "b3.1", text: "Missing line.", tokens: ["missing", "line"] },
  ],
  cues: [
    { id: "g1", kind: "gfx", optional: false, text: "a test card", flags: [], sectionId: "sec0", afterSentenceId: "s0.1", holdSection: false },
    { id: "g2", kind: "gfx", optional: true, text: "optional card", flags: [], sectionId: "sec2", afterSentenceId: "s1.1", holdSection: false },
  ],
};

const candidates: Candidates = {
  sentences: [
    { sentenceId: "s0.1", chosen: 1, occurrences: [
      { clipId: "c1", startWordId: "w2", endWordId: "w3", score: 0.6 },
      { clipId: "c1", startWordId: "w7", endWordId: "w8", score: 1 },
    ] },
    { sentenceId: "s0.2", chosen: 0, occurrences: [{ clipId: "c1", startWordId: "w10", endWordId: "w13", score: 1 }] },
    { sentenceId: "s1.1", chosen: 1, occurrences: [
      { clipId: "c1", startWordId: "w14", endWordId: "w16", score: 1 },
      { clipId: "c2", startWordId: "w21", endWordId: "w23", score: 1 },
    ] },
    { sentenceId: "s2.1", chosen: null, occurrences: [] },
  ],
  adlibs: [{ clipId: "c1", startWordId: "w17", endWordId: "w18" }],
  missing: ["s2.1"],
};

const plan: EditPlan = {
  takes: [
    { sentenceIds: ["s0.1"], chosen: { startWordId: "w7", endWordId: "w8" }, alternates: [{ startWordId: "w2", endWordId: "w3" }], why: "second try is clean" },
    { sentenceIds: ["s0.2"], chosen: { startWordId: "w10", endWordId: "w13" }, alternates: [], why: "only take" },
    // the c1 attempt at s1.1 is deliberately missing: the compiler must add it as an alternate
    { sentenceIds: ["s1.1"], chosen: { startWordId: "w21", endWordId: "w23" }, alternates: [], why: "retake in clip 2" },
    { sentenceIds: ["s9.9"], chosen: { startWordId: "w99", endWordId: "w100" }, alternates: [], why: "bogus" },
  ],
  adlibs: [{ startWordId: "w17", endWordId: "w18", keep: false, why: "tangent" }],
  wordCuts: [{ startWordId: "w12", endWordId: "w12", reason: "stumble" }],
  fillerGaps: [{ fillerId: "f9", cut: true }],
  cues: [
    { cueId: "g1", include: true, anchorWordId: "w10", endWordId: "w13", layout: "side", brief: "card slides in on 'This'" },
    { cueId: "g2", include: false, anchorWordId: "w21", endWordId: "w23", layout: "side", brief: "" },
    { cueId: "g7", include: true, anchorWordId: "w0", endWordId: "w1", layout: "full", brief: "not a real cue" },
  ],
  notes: "",
};

const ctx = { script, transcript, candidates, clips };
const find = (cuts: Cut[], pred: (c: Cut) => boolean) => cuts.filter(pred);

describe("planToEdit", () => {
  const { edit, warnings } = planToEdit(plan, ctx);

  it("produces a valid edit at version 1", () => {
    expect(() => EditSchema.parse(edit)).not.toThrow();
    expect(edit.version).toBe(1);
  });

  it("orders clips by where their chosen takes sit in the script", () => {
    expect(edit.clipOrder).toEqual(["c1", "c2"]);
  });

  it("builds take groups, chosen first, and adds aligner retakes the plan left out", () => {
    expect(edit.takeGroups.map((g) => g.sentenceIds)).toEqual([["s0.1"], ["s0.2"], ["s1.1"]]);
    const [g1, , g3] = edit.takeGroups;
    expect(g1!.chosen).toBe(0);
    expect(g1!.options.map((o) => [o.startWordId, o.endWordId, o.start, o.end])).toEqual([["w7", "w8", 4.5, 5.2], ["w2", "w3", 2.0, 2.7]]);
    expect(g3!.options.map((o) => o.startWordId)).toEqual(["w21", "w14"]);
    expect(warnings.some((w) => w.includes("retake of s1.1"))).toBe(true);
    expect(warnings.some((w) => w.includes("w99"))).toBe(true);
    expect(new Set(edit.takeGroups.map((g) => g.id)).size).toBe(3);
  });

  it("turns word cuts, ad-libs and fillers into cuts", () => {
    expect(find(edit.cuts, (c) => c.by === "claude" && c.reason === "stumble")).toMatchObject([{ clipId: "c1", start: 6.25, end: 6.3, enabled: true }]);
    expect(find(edit.cuts, (c) => c.reason === "adlib")).toMatchObject([{ start: 8.9, end: 9.5, enabled: true, note: "tangent", by: "claude" }]);
    // the "um" token Claude didn't mention is cut automatically
    expect(find(edit.cuts, (c) => c.reason === "filler" && c.start === 5.4)).toMatchObject([{ by: "auto", enabled: true }]);
    // the undecided voiced gap is offered, switched off
    expect(find(edit.cuts, (c) => c.reason === "filler" && c.start === 6.8)).toMatchObject([{ by: "auto", enabled: false }]);
    // a gap inside the trimmed head is not offered separately
    expect(find(edit.cuts, (c) => c.reason === "filler" && c.start === 0.85)).toHaveLength(0);
    expect(warnings.some((w) => w.includes("f9"))).toBe(true);
  });

  it("cuts stray speech between takes and trims each clip's head and tail", () => {
    expect(find(edit.cuts, (c) => c.clipId === "c1" && c.start === 3.0)).toMatchObject([{ end: 3.8, reason: "repeat", by: "auto", enabled: true }]);
    expect(find(edit.cuts, (c) => c.clipId === "c1" && c.start === 0)).toMatchObject([{ end: 1.2, reason: "repeat" }]);
    expect(find(edit.cuts, (c) => c.clipId === "c1" && c.start === 11.0)).toMatchObject([{ end: 13, reason: "repeat" }]);
    expect(find(edit.cuts, (c) => c.clipId === "c2" && c.reason === "silence").map((c) => [c.start, c.end])).toEqual([[0, 0.5], [2.5, 3]]);
  });

  it("creates overlays for included cues only", () => {
    expect(edit.overlays).toEqual([{
      id: "o-g1", cueId: "g1", enabled: true, anchorWordId: "w10", endWordId: "w13", offsetMs: 0, layout: "side", brief: "card slides in on 'This'", assetIds: [],
    }]);
    expect(warnings.some((w) => w.includes("g7"))).toBe(true);
  });

  it("anchors one chapter per ## section at its first spoken sentence", () => {
    expect(edit.chapters).toEqual([
      { title: "Cold open", anchorWordId: "w7" },
      { title: "1. The next part", anchorWordId: "w21" },
    ]);
  });

  it("keeps exactly the chosen script words through the timeline", () => {
    const kept = keptWordIds(edit, transcript);
    expect([...kept]).toEqual(["w7", "w8", "w10", "w11", "w13", "w21", "w22", "w23"]);
    const config = ConfigSchema.parse({});
    const tl = buildTimeline(edit, transcript, clips, config);
    expect(tl.segments.map((s) => s.clipId)).toEqual(["c1", "c1", "c1", "c2"]);
    expect(tl.overlays.map((o) => o.cueId)).toEqual(["g1"]);
    expect(tl.chapters[0]).toEqual({ title: "Cold open", start: 0 });
  });

  it("carries user tweaks over from the previous edit", () => {
    const previous: Edit = {
      ...edit,
      version: 4,
      intro: false,
      overlays: [{ ...edit.overlays[0]!, enabled: false, offsetMs: 250, durMs: 3000, assetIds: ["a1"] }],
      cuts: [...edit.cuts, { id: "u1", clipId: "c1", start: 6.05, end: 6.2, reason: "user", by: "user", enabled: true }],
    };
    const next = planToEdit(plan, { ...ctx, previous }).edit;
    expect(next.version).toBe(5);
    expect(next.intro).toBe(false);
    expect(next.overlays[0]).toMatchObject({ enabled: false, offsetMs: 250, durMs: 3000, assetIds: ["a1"] });
    expect(next.cuts.filter((c) => c.by === "user")).toHaveLength(1);
    expect(new Set(next.cuts.map((c) => c.id)).size).toBe(next.cuts.length);
  });

  it("gives a sentence Claude skipped the aligner's take", () => {
    const partial: EditPlan = { ...plan, takes: plan.takes.filter((t) => t.sentenceIds[0] !== "s0.2") };
    const res = planToEdit(partial, ctx);
    const g = res.edit.takeGroups.find((g) => g.sentenceIds.includes("s0.2"))!;
    expect(g.options[g.chosen]!.startWordId).toBe("w10");
    expect(res.warnings.some((w) => w.includes("s0.2 was not in the plan"))).toBe(true);
  });
});

describe("chapterTitle", () => {
  it("drops planning timecodes", () => {
    expect(chapterTitle("Cold open (0:00–0:40)")).toBe("Cold open");
    expect(chapterTitle("2. The two job postings (2:00-4:50)")).toBe("2. The two job postings");
    expect(chapterTitle("Plain")).toBe("Plain");
  });
});
