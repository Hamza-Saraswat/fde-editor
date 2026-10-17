import { describe, expect, it } from "vitest";
import { ConfigSchema, type Clip, type Cut, type Edit, type TakeGroup, type Transcript, type Word } from "../src/core/schema.ts";
import { buildTimeline, keptWordIds, outputToSource, sourceToOutput, trimToRemoval, wordToOutput } from "../src/core/timeline.ts";

// ---------- helpers ----------

let nextWord = 0;
function words(clipId: string, spec: [string, number, number][]): Word[] {
  return spec.map(([text, start, end]) => ({ id: `w${nextWord++}`, clipId, text, start, end }));
}
const transcriptOf = (ws: Word[]): Transcript => ({ engine: "test", model: "test", words: ws, silences: [], fillers: [] });
const clip = (id: string, duration: number): Clip => ({
  id, name: id, path: `/x/${id}.mov`, duration, width: 2560, height: 1440, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false,
});
const editOf = (over: Partial<Edit> = {}): Edit => ({
  version: 1, clipOrder: ["c1"], cuts: [], takeGroups: [], overlays: [], chapters: [], intro: true, outro: true, ...over,
});
const cut = (clipId: string, start: number, end: number, enabled = true): Cut =>
  ({ id: `k${start}`, clipId, start, end, reason: "filler", by: "auto", enabled });
const config = (fps = 30, edit: Record<string, number> = {}) => ConfigSchema.parse({ output: { fps }, edit });
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

// ---------- tests ----------

describe("buildTimeline", () => {
  it("snaps segment bounds to the frame grid", () => {
    const ws = words("c1", [["hello", 1.013, 1.5]]);
    const tl = buildTimeline(editOf(), transcriptOf(ws), [clip("c1", 10)], config(30));
    expect(tl.segments).toHaveLength(1);
    const s = tl.segments[0]!;
    // snapping widens: 1.013 - 0.08 = 0.933 -> frame 27.99 -> 27 (down); 1.5 + 0.12 = 1.62 -> 48.6 -> 49 (up)
    near(s.start * 30, 27);
    near(s.end * 30, 49);
    expect(s.frames).toBe(22);
    expect(s.outStart).toBe(0);
    near(tl.duration, 22 / 30);
  });

  it("pads kept words with preMs before and postMs after", () => {
    const ws = words("c1", [["hello", 1.0, 1.4], ["world", 1.5, 2.0]]);
    const tl = buildTimeline(editOf(), transcriptOf(ws), [clip("c1", 10)], config(100));
    expect(tl.segments).toHaveLength(1);
    near(tl.segments[0]!.start, 0.92);
    near(tl.segments[0]!.end, 2.12);
  });

  it("clamps padding to the clip bounds", () => {
    const ws = words("c1", [["hi", 0.03, 0.4], ["there", 0.45, 1.95]]);
    const tl = buildTimeline(editOf(), transcriptOf(ws), [clip("c1", 2.0)], config(100));
    near(tl.segments[0]!.start, 0);
    near(tl.segments[0]!.end, 2.0);
  });

  it("never lets padding re-include a cut filler word", () => {
    const ws = words("c1", [["so", 1.0, 1.3], ["um", 1.35, 1.75], ["this", 1.8, 2.1]]);
    const t = transcriptOf(ws);
    const tl = buildTimeline(editOf({ cuts: [cut("c1", 1.35, 1.75)] }), t, [clip("c1", 10)], config(100));
    expect(tl.segments).toHaveLength(2);
    const [a, b] = tl.segments;
    expect(a!.end).toBeLessThanOrEqual(1.35 + 1e-9); // 1.3 + 0.12 would reach into the "um"
    expect(b!.start).toBeGreaterThanOrEqual(1.75 - 1e-9); // 1.8 - 0.08 would too
    near(a!.start, 0.92);
    near(b!.end, 2.22);
    expect(keptWordIds(editOf({ cuts: [cut("c1", 1.35, 1.75)] }), t).has(ws[1]!.id)).toBe(false);
  });

  it("removes gap-only cuts as time ranges and breaks the island there", () => {
    const ws = words("c1", [["one", 1.0, 1.3], ["two", 1.6, 1.9]]);
    const tl = buildTimeline(editOf({ cuts: [cut("c1", 1.3, 1.6)] }), transcriptOf(ws), [clip("c1", 10)], config(100));
    expect(tl.segments.map((s) => [s.start, s.end])).toEqual([[0.92, 1.3], [1.6, 2.02]]);
  });

  it("tightens a long natural pause to about maxPauseMs instead of removing it", () => {
    const ws = words("c1", [["a", 1.0, 1.5], ["b", 3.0, 3.5]]);
    const cfg = config(100);
    const tl = buildTimeline(editOf(), transcriptOf(ws), [clip("c1", 10)], cfg);
    expect(tl.segments).toHaveLength(2);
    const outPause = sourceToOutput(tl, "c1", 3.0)! - sourceToOutput(tl, "c1", 1.5)!;
    near(outPause, cfg.edit.maxPauseMs / 1000, 0.02);
    // a short pause stays as recorded
    const ws2 = words("c1", [["a", 1.0, 1.5], ["b", 1.8, 2.2]]);
    const tl2 = buildTimeline(editOf(), transcriptOf(ws2), [clip("c1", 10)], cfg);
    expect(tl2.segments).toHaveLength(1);
  });

  it("swapping a take swaps the segments", () => {
    const ws = words("c1", [["first", 1.0, 1.4], ["try", 1.5, 1.9], ["second", 3.0, 3.4], ["try", 3.5, 3.9]]);
    const t = transcriptOf(ws);
    const group = (chosen: number): TakeGroup => ({
      id: "tg1", sentenceIds: ["s1"], chosen, why: "",
      options: [
        { clipId: "c1", startWordId: ws[2]!.id, endWordId: ws[3]!.id, start: 3.0, end: 3.9 },
        { clipId: "c1", startWordId: ws[0]!.id, endWordId: ws[1]!.id, start: 1.0, end: 1.9 },
      ],
    });
    const late = buildTimeline(editOf({ takeGroups: [group(0)] }), t, [clip("c1", 10)], config(100));
    expect(late.segments.map((s) => [s.start, s.end])).toEqual([[2.92, 4.02]]);
    const early = buildTimeline(editOf({ takeGroups: [group(1)] }), t, [clip("c1", 10)], config(100));
    expect(early.segments.map((s) => [s.start, s.end])).toEqual([[0.92, 2.02]]);
    expect([...keptWordIds(editOf({ takeGroups: [group(1)] }), t)]).toEqual([ws[0]!.id, ws[1]!.id]);
  });

  it("a disabled cut restores its words", () => {
    const ws = words("c1", [["keep", 1.0, 1.3], ["maybe", 1.35, 1.7], ["keep", 1.75, 2.0]]);
    const t = transcriptOf(ws);
    const on = editOf({ cuts: [cut("c1", 1.35, 1.7, true)] });
    const off = editOf({ cuts: [cut("c1", 1.35, 1.7, false)] });
    expect(keptWordIds(on, t).has(ws[1]!.id)).toBe(false);
    expect(keptWordIds(off, t).has(ws[1]!.id)).toBe(true);
    const tlOff = buildTimeline(off, t, [clip("c1", 10)], config(100));
    expect(tlOff.segments).toHaveLength(1);
    expect(tlOff.duration).toBeGreaterThan(buildTimeline(on, t, [clip("c1", 10)], config(100)).duration);
  });

  it("plays clips in clipOrder and leaves out unlisted clips", () => {
    const a = words("c1", [["one", 1.0, 1.5]]);
    const b = words("c2", [["two", 2.0, 2.5]]);
    const c = words("c3", [["three", 1.0, 1.5]]);
    const t = transcriptOf([...a, ...b, ...c]);
    const clips = [clip("c1", 5), clip("c2", 5), clip("c3", 5)];
    const tl = buildTimeline(editOf({ clipOrder: ["c2", "c1"] }), t, clips, config(30));
    expect(tl.segments.map((s) => s.clipId)).toEqual(["c2", "c1"]);
    near(tl.segments[1]!.outStart, tl.segments[0]!.frames / 30);
    expect(keptWordIds(editOf({ clipOrder: ["c2", "c1"] }), t).has(c[0]!.id)).toBe(false);
  });

  it("drops islands shorter than two frames", () => {
    const ws = words("c1", [["x", 1.0, 1.01]]);
    const cfg = config(30, { preMs: 0, postMs: 0 });
    expect(buildTimeline(editOf(), transcriptOf(ws), [clip("c1", 5)], cfg).segments).toHaveLength(0);
  });
});

describe("source/output mapping", () => {
  const ws = words("c1", [["a", 1.0, 1.4], ["b", 1.5, 1.9], ["um", 2.0, 2.4], ["c", 2.5, 3.0], ["d", 6.0, 6.5]]);
  const ws2 = words("c2", [["e", 0.5, 1.0]]);
  const t = transcriptOf([...ws, ...ws2]);
  const tl = buildTimeline(editOf({ clipOrder: ["c1", "c2"], cuts: [cut("c1", 2.0, 2.4)] }), t, [clip("c1", 8), clip("c2", 3)], config(30));

  it("round-trips output → source → output", () => {
    expect(tl.segments.length).toBeGreaterThanOrEqual(3);
    for (let x = 0; x < tl.duration; x += 0.137) {
      const src = outputToSource(tl, x)!;
      expect(src).not.toBeNull();
      near(sourceToOutput(tl, src.clipId, src.t)!, x, 1e-6);
    }
  });

  it("round-trips source → output → source inside kept segments", () => {
    for (const s of tl.segments) {
      const mid = (s.start + s.end) / 2;
      const out = sourceToOutput(tl, s.clipId, mid)!;
      expect(outputToSource(tl, out)).toEqual({ clipId: s.clipId, t: expect.closeTo(mid, 6) });
    }
  });

  it("returns null for cut material and outside the timeline", () => {
    expect(sourceToOutput(tl, "c1", 2.2)).toBeNull();
    expect(sourceToOutput(tl, "c3", 1)).toBeNull();
    expect(outputToSource(tl, -1)).toBeNull();
    expect(outputToSource(tl, tl.duration + 1)).toBeNull();
  });
});

describe("overlays and chapters", () => {
  const ws = words("c1", [
    ["intro", 1.0, 1.4], ["um", 1.5, 2.3], ["so", 2.4, 2.6], ["the", 2.65, 2.8], ["stack", 2.85, 3.3], ["has", 3.35, 3.6], ["three", 3.65, 4.0], ["layers", 4.05, 4.6],
  ]);
  const t = transcriptOf(ws);
  const id = (i: number) => ws[i]!.id;
  const overlay = { id: "o-g1", cueId: "g1", enabled: true, anchorWordId: id(4), endWordId: id(7), offsetMs: 0, layout: "side" as const, brief: "", assetIds: [] };
  const clips = [clip("c1", 10)];

  it("an overlay follows its anchor word when an earlier cut shifts the timeline", () => {
    const before = buildTimeline(editOf({ overlays: [overlay] }), t, clips, config(30));
    const after = buildTimeline(editOf({ overlays: [overlay], cuts: [cut("c1", 1.5, 2.3)] }), t, clips, config(30));
    const ob = before.overlays[0]!;
    const oa = after.overlays[0]!;
    near(ob.start, sourceToOutput(before, "c1", 2.85)!);
    near(oa.start, sourceToOutput(after, "c1", 2.85)!);
    expect(ob.start - oa.start).toBeGreaterThan(0.5); // the "um" no longer plays before it
    near(oa.end, sourceToOutput(after, "c1", 4.6)!);
  });

  it("applies offsetMs and durMs, and moves off cut anchor words", () => {
    const shifted = buildTimeline(editOf({ overlays: [{ ...overlay, offsetMs: 250, durMs: 1000 }] }), t, clips, config(30));
    const o = shifted.overlays[0]!;
    near(o.start, sourceToOutput(shifted, "c1", 2.85)! + 0.25);
    near(o.end - o.start, 1.0);
    // anchor on a cut word: the next kept word takes over
    const onCut = buildTimeline(editOf({ overlays: [{ ...overlay, anchorWordId: id(1) }], cuts: [cut("c1", 1.5, 2.3)] }), t, clips, config(30));
    near(onCut.overlays[0]!.start, sourceToOutput(onCut, "c1", 2.4)!);
  });

  it("drops overlays shorter than half a second and disabled ones", () => {
    const short = buildTimeline(editOf({ overlays: [{ ...overlay, durMs: 300 }] }), t, clips, config(30));
    expect(short.overlays).toHaveLength(0);
    const off = buildTimeline(editOf({ overlays: [{ ...overlay, enabled: false }] }), t, clips, config(30));
    expect(off.overlays).toHaveLength(0);
  });

  it("puts a chapter anchored on the first word at 0, and sorts chapters", () => {
    const tl = buildTimeline(editOf({ chapters: [{ title: "Stack", anchorWordId: id(4) }, { title: "Intro", anchorWordId: id(0) }] }), t, clips, config(30));
    expect(tl.chapters.map((c) => c.title)).toEqual(["Intro", "Stack"]);
    expect(tl.chapters[0]!.start).toBe(0);
    near(tl.chapters[1]!.start, sourceToOutput(tl, "c1", 2.85)!);
  });
});

describe("take groups that overlap another group's chosen take", () => {
  it("never removes words that belong to a different sentence's chosen take", () => {
    // "…using the same title." (group A, chosen) — "Same title." (group B) has a bogus alternate inside A.
    const ws = words("c1", [["using", 0, 0.3], ["the", 0.35, 0.5], ["same", 0.55, 0.8], ["title.", 0.85, 1.2], ["Same", 2.0, 2.3], ["title.", 2.35, 2.7]]);
    const [w0, , w2, w3, w4, w5] = ws.map((w) => w.id);
    const opt = (a: Word, b: Word) => ({ clipId: "c1", startWordId: a.id, endWordId: b.id, start: a.start, end: b.end });
    const edit = editOf({
      takeGroups: [
        { id: "A", sentenceIds: ["s1"], options: [opt(ws[0]!, ws[3]!)], chosen: 0, why: "" },
        { id: "B", sentenceIds: ["s4"], options: [opt(ws[4]!, ws[5]!), opt(ws[2]!, ws[3]!)], chosen: 0, why: "" },
      ],
    });
    const kept = keptWordIds(edit, transcriptOf(ws));
    for (const id of [w0, w2, w3, w4, w5]) expect(kept.has(id!)).toBe(true);
    const tl = buildTimeline(edit, transcriptOf(ws), [clip("c1", 3)], config());
    // the first sentence plays through "title." (no hole where the bogus alternate was)
    expect(tl.segments[0]!.start).toBeLessThanOrEqual(0.0001);
    expect(tl.segments[0]!.end).toBeGreaterThanOrEqual(1.2);
  });
});

describe("overlay nudges", () => {
  it("moves the whole graphic: start and end shift together, length unchanged", () => {
    const ws = words("c1", [["one", 0, 0.4], ["two", 0.5, 0.9], ["three", 1.0, 1.4], ["four", 1.5, 1.9], ["five", 2.0, 2.4]]);
    const ov = (offsetMs: number) => ({ id: "o-g1", cueId: "g1", enabled: true, anchorWordId: ws[1]!.id, endWordId: ws[3]!.id, offsetMs, layout: "side" as const, brief: "", assetIds: [] });
    const base = buildTimeline(editOf({ overlays: [ov(0)] }), transcriptOf(ws), [clip("c1", 3)], config()).overlays[0]!;
    const moved = buildTimeline(editOf({ overlays: [ov(300)] }), transcriptOf(ws), [clip("c1", 3)], config()).overlays[0]!;
    near(moved.start - base.start, 0.3);
    near(moved.end - base.end, 0.3);
  });
});

describe("snapping never clips a kept word", () => {
  it("a filler cut that ends exactly where the next kept word starts keeps that word's onset", () => {
    // live run: "field, um, chasing" with "um," cut at its exact word bounds (25.68–26.32)
    const ws = words("c1", [["field,", 25.28, 25.68], ["um,", 25.68, 26.32], ["chasing", 26.32, 26.72], ["the", 26.72, 26.8]]);
    const tl = buildTimeline(editOf({ cuts: [cut("c1", 25.68, 26.32)] }), transcriptOf(ws), [clip("c1", 30)], config(30));
    const seg = tl.segments.find((x) => x.end > 26.5)!;
    expect(seg.start).toBeLessThanOrEqual(26.32); // 26.32 * 30 = 789.6 -> frame 789, not 790
    expect(sourceToOutput(tl, "c1", 26.32)).not.toBeNull();
  });
});

describe("cuts win over sloppy word stamps", () => {
  it("a cut over the edge of a kept word trims that edge instead of being overruled", () => {
    // real take: "more. [uh] One," — the sweep cut the uh at 137.24–137.47, but Parakeet stamped "One,"
    // from 137.36, and the word's stamp used to put 110 ms of the uh back
    const ws = words("c1", [["more.", 136.48, 136.6], ["One,", 137.36, 137.84]]);
    const c = cut("c1", 137.24, 137.47);
    const tl = buildTimeline(editOf({ cuts: [c] }), transcriptOf(ws), [clip("c1", 140)], config(30));
    const seg = tl.segments.find((s) => s.end > 137.6)!;
    expect(seg.start).toBeGreaterThanOrEqual(137.46); // 137.47 snapped down one frame at most
    expect(keptWordIds(editOf({ cuts: [c] }), transcriptOf(ws)).has(ws[1]!.id)).toBe(true);
  });

  it("trims only up to the word's midpoint, and ignores a trim that leaves under 60 ms", () => {
    const w = { id: "x", clipId: "c1", text: "family", start: 0.69, end: 1.21 };
    expect(trimToRemoval(w, [{ start: 1.01, end: 1.25 }])).toMatchObject({ start: 0.69, end: 1.01 });
    expect(trimToRemoval(w, [{ start: 0.5, end: 0.8 }])).toMatchObject({ start: 0.8, end: 1.21 });
    const short = { id: "y", clipId: "c1", text: "a", start: 1.0, end: 1.08 };
    expect(trimToRemoval(short, [{ start: 0.9, end: 1.03 }])).toBe(short);
  });

  it("maps a trimmed word to output by its midpoint", () => {
    const ws = words("c1", [["more.", 0.0, 0.2], ["One,", 0.36, 0.84]]);
    const tl = buildTimeline(editOf({ cuts: [cut("c1", 0.24, 0.47)] }), transcriptOf(ws), [clip("c1", 3)], config(30));
    expect(sourceToOutput(tl, "c1", 0.36)).toBeNull(); // its raw start is now cut material
    const at = wordToOutput(tl, ws[1]!)!;
    expect(at).not.toBeNull();
    expect(at.end - at.start).toBeGreaterThan(0.3);
  });
});

describe("punch-ins", () => {
  const ws = words("c1", [["a", 1.0, 1.4], ["b", 2.0, 2.4], ["c", 3.0, 3.4], ["d", 4.0, 4.4]]);
  const cuts = [cut("c1", 1.5, 1.9), cut("c1", 2.5, 2.9), cut("c1", 3.5, 3.9)];

  it("are off unless the edit turns them on", () => {
    const tl = buildTimeline(editOf({ cuts }), transcriptOf(ws), [clip("c1", 10)], config(30));
    expect(tl.segments.map((s) => s.zoom)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("zoom every other segment of one take, and restart unzoomed on a new clip", () => {
    const w2 = words("c2", [["e", 0.5, 0.9], ["f", 1.5, 1.9]]);
    const edit = editOf({ cuts: [...cuts, cut("c2", 1.0, 1.4)], clipOrder: ["c1", "c2"], punchIn: true });
    const tl = buildTimeline(edit, transcriptOf([...ws, ...w2]), [clip("c1", 10), clip("c2", 10)], config(30));
    expect(tl.segments.map((s) => s.zoom)).toEqual([undefined, 1.1, undefined, 1.1, undefined, 1.1]);
  });
});
