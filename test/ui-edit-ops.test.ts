// Pure UI logic: edit mutations, the undo/redo reducer, timeline math, word states and placement.
import { describe, expect, it } from "vitest";
import type { Edit, Timeline, Transcript, Word } from "../src/core/schema.ts";
import {
  addUserCut, arollChanged, attachAsset, chooseTake, deleteCut, detachAsset, nextUserCutId, nudgeOverlay, resetOverlayTiming,
  setCutEnabled, setOverlayDuration, setReasonEnabled, toggleCut, updateOverlay,
} from "../web/src/lib/editOps.ts";
import { COALESCE_MS, HISTORY_LIMIT, canRedo, canUndo, historyReducer, initHistory, type History } from "../web/src/lib/history.ts";
import { fitZoom, formatClock, formatTimecode, rulerTicks, scrollForZoom, snapMs, snapToFrame, zoomStep, MAX_PPS, MIN_PPS } from "../web/src/lib/timelineMath.ts";
import { indexWords, readingOrder, toLines, wordStatuses, wordlessCuts, wordsBetween } from "../web/src/lib/words.ts";
import { outputToSource, sourceToOutput, wordAt, wordOutputTimes } from "../web/src/lib/timemap.ts";
import { overlaySide, placeOverlays, segmentJoins } from "../web/src/lib/placement.ts";
import { buildMockFixture } from "../web/src/dev/mockData.ts";
import { mockTimeline } from "../web/src/dev/mockTimeline.ts";

// ---------- fixtures ----------

const W = (id: string, clipId: string, start: number, end: number, text = id): Word => ({ id, clipId, start, end, text });

const words: Word[] = [
  W("w0", "c1", 0.5, 0.8, "One"),
  W("w1", "c1", 0.85, 1.0, "wants"),
  W("w2", "c1", 1.1, 1.4, "um"),
  W("w3", "c1", 1.5, 1.9, "a"),
  W("w4", "c1", 2.0, 2.5, "developer."),
  // retake of the same line
  W("w5", "c1", 3.5, 3.8, "One"),
  W("w6", "c1", 3.85, 4.1, "wants"),
  W("w7", "c1", 4.2, 4.4, "a"),
  W("w8", "c1", 4.5, 5.0, "developer."),
  W("w9", "c2", 0.4, 0.8, "Next"),
  W("w10", "c2", 0.9, 1.3, "clip."),
];

const transcript: Transcript = { engine: "test", model: "test", words, silences: [], fillers: [{ id: "f0", clipId: "c1", start: 1.1, end: 1.4, kind: "token", wordId: "w2" }] };

function baseEdit(): Edit {
  return {
    version: 4,
    clipOrder: ["c1", "c2"],
    cuts: [
      { id: "k1", clipId: "c1", start: 1.1, end: 1.4, reason: "filler", by: "auto", enabled: true },
      { id: "k2", clipId: "c1", start: 2.6, end: 3.3, reason: "silence", by: "auto", enabled: true }, // no words inside
      { id: "u1", clipId: "c2", start: 0.9, end: 1.3, reason: "user", by: "user", enabled: false },
    ],
    takeGroups: [
      {
        id: "tg1",
        sentenceIds: ["s0.2"],
        options: [
          { clipId: "c1", startWordId: "w0", endWordId: "w4", start: 0.5, end: 2.5 },
          { clipId: "c1", startWordId: "w5", endWordId: "w8", start: 3.5, end: 5.0 },
        ],
        chosen: 1,
        why: "take 2 is clean",
      },
    ],
    overlays: [
      { id: "o-g1", cueId: "g1", enabled: true, anchorWordId: "w5", endWordId: "w8", offsetMs: 0, layout: "side", brief: "cards", assetIds: [] },
      { id: "o-g2", cueId: "g2", enabled: false, anchorWordId: "w9", endWordId: "w10", offsetMs: 0, layout: "split", brief: "split", assetIds: [] },
    ],
    chapters: [{ title: "Start", anchorWordId: "w5" }],
    intro: true,
    outro: true,
  };
}

// ---------- edit mutations ----------

describe("edit ops: cuts", () => {
  it("toggles a cut and leaves the input untouched", () => {
    const e = baseEdit();
    const next = toggleCut(e, "k1");
    expect(next.cuts.find((c) => c.id === "k1")!.enabled).toBe(false);
    expect(e.cuts.find((c) => c.id === "k1")!.enabled).toBe(true);
    expect(toggleCut(next, "k1").cuts.find((c) => c.id === "k1")!.enabled).toBe(true);
  });

  it("returns the same object when nothing changes", () => {
    const e = baseEdit();
    expect(toggleCut(e, "nope")).toBe(e);
    expect(setCutEnabled(e, "k1", true)).toBe(e);
    expect(setReasonEnabled(e, "repeat", true)).toBe(e);
  });

  it("adds a user cut spanning the selected words, with the next free id", () => {
    const e = baseEdit();
    expect(nextUserCutId(e)).toBe("u2");
    const next = addUserCut(e, [words[0]!, words[1]!]);
    const cut = next.cuts.at(-1)!;
    expect(cut).toEqual({ id: "u2", clipId: "c1", start: 0.5, end: 1.0, reason: "user", by: "user", enabled: true });
    expect(next.cuts).toHaveLength(e.cuts.length + 1);
  });

  it("splits a selection across clips into one cut per clip", () => {
    const next = addUserCut(baseEdit(), [words[8]!, words[9]!]);
    const added = next.cuts.slice(-2);
    expect(added.map((c) => [c.id, c.clipId, c.start, c.end])).toEqual([
      ["u2", "c1", 4.5, 5.0],
      ["u3", "c2", 0.4, 0.8],
    ]);
  });

  it("re-enables an identical user cut instead of duplicating it", () => {
    const e = baseEdit();
    const next = addUserCut(e, [words[10]!]);
    expect(next.cuts).toHaveLength(e.cuts.length);
    expect(next.cuts.find((c) => c.id === "u1")!.enabled).toBe(true);
  });

  it("adds nothing for an empty selection", () => {
    const e = baseEdit();
    expect(addUserCut(e, [])).toBe(e);
  });

  it("deletes only user-made cuts", () => {
    const e = baseEdit();
    expect(deleteCut(e, "k1")).toBe(e);
    expect(deleteCut(e, "u1").cuts.map((c) => c.id)).toEqual(["k1", "k2"]);
  });

  it("switches every cut of a reason", () => {
    const next = setReasonEnabled(baseEdit(), "filler", false);
    expect(next.cuts.find((c) => c.id === "k1")!.enabled).toBe(false);
    expect(next.cuts.find((c) => c.id === "k2")!.enabled).toBe(true);
  });
});

describe("edit ops: takes", () => {
  it("chooses a take", () => {
    const next = chooseTake(baseEdit(), "tg1", 0);
    expect(next.takeGroups[0]!.chosen).toBe(0);
  });
  it("ignores out-of-range and unchanged choices", () => {
    const e = baseEdit();
    expect(chooseTake(e, "tg1", 1)).toBe(e);
    expect(chooseTake(e, "tg1", 5)).toBe(e);
    expect(chooseTake(e, "tg1", -1)).toBe(e);
    expect(chooseTake(e, "nope", 0)).toBe(e);
  });
});

describe("edit ops: overlays", () => {
  it("nudges by whole frames", () => {
    const next = nudgeOverlay(baseEdit(), "o-g1", 50, 30); // 50 ms -> 2 frames at 30 fps
    expect(next.overlays[0]!.offsetMs).toBeCloseTo(66.667, 3);
    expect(nudgeOverlay(baseEdit(), "o-g1", -10, 30).overlays[0]!.offsetMs).toBe(0);
    expect(nudgeOverlay(baseEdit(), "o-g1", -40, 25).overlays[0]!.offsetMs).toBe(-40);
  });

  it("is a no-op when the snapped nudge doesn't change", () => {
    const e = baseEdit();
    expect(nudgeOverlay(e, "o-g1", 10, 30)).toBe(e);
  });

  it("sets a snapped length with a 0.5 s floor, and clears it", () => {
    const e = baseEdit();
    const a = setOverlayDuration(e, "o-g1", 2000, 30);
    expect(a.overlays[0]!.durMs).toBe(2000);
    const b = setOverlayDuration(e, "o-g1", 120, 30);
    expect(b.overlays[0]!.durMs).toBeCloseTo(500, 3);
    const frames = (b.overlays[0]!.durMs! * 30) / 1000;
    expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-4);
    const c = setOverlayDuration(a, "o-g1", undefined, 30);
    expect("durMs" in c.overlays[0]!).toBe(false);
    expect(setOverlayDuration(e, "o-g1", undefined, 30)).toBe(e);
  });

  it("resets timing to Claude's placement", () => {
    let e = nudgeOverlay(baseEdit(), "o-g1", 300, 30);
    e = setOverlayDuration(e, "o-g1", 4000, 30);
    const r = resetOverlayTiming(e, "o-g1");
    expect(r.overlays[0]!.offsetMs).toBe(0);
    expect("durMs" in r.overlays[0]!).toBe(false);
    expect(resetOverlayTiming(r, "o-g1")).toBe(r);
  });

  it("updates brief, layout, side and enabled", () => {
    const e = baseEdit();
    const next = updateOverlay(e, "o-g1", { brief: "new", layout: "full", side: "left", enabled: false });
    expect(next.overlays[0]).toMatchObject({ brief: "new", layout: "full", side: "left", enabled: false });
    expect(updateOverlay(next, "o-g1", { brief: "new" })).toBe(next);
  });

  it("attaches and detaches assets once", () => {
    const e = attachAsset(baseEdit(), "o-g1", "a1");
    expect(e.overlays[0]!.assetIds).toEqual(["a1"]);
    expect(attachAsset(e, "o-g1", "a1")).toBe(e);
    expect(detachAsset(e, "o-g1", "a1").overlays[0]!.assetIds).toEqual([]);
  });

  it("knows when the A-roll changed", () => {
    const e = baseEdit();
    expect(arollChanged(e, nudgeOverlay(e, "o-g1", 100, 30))).toBe(false);
    expect(arollChanged(e, toggleCut(e, "k1"))).toBe(true);
    expect(arollChanged(e, chooseTake(e, "tg1", 0))).toBe(true);
  });
});

// ---------- undo / redo ----------

describe("history reducer", () => {
  const e0 = baseEdit();
  const e1 = toggleCut(e0, "k1");
  const e2 = chooseTake(e1, "tg1", 0);

  it("applies, undoes and redoes", () => {
    let h: History = initHistory(e0);
    expect(canUndo(h)).toBe(false);
    h = historyReducer(h, { type: "apply", edit: e1, at: 0 });
    h = historyReducer(h, { type: "apply", edit: e2, at: 5000 });
    expect(h.present).toBe(e2);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(e1);
    expect(canRedo(h)).toBe(true);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(e0);
    expect(historyReducer(h, { type: "undo" })).toBe(h);
    h = historyReducer(h, { type: "redo" });
    h = historyReducer(h, { type: "redo" });
    expect(h.present).toBe(e2);
    expect(historyReducer(h, { type: "redo" })).toBe(h);
  });

  it("a new change after undo drops the redo stack", () => {
    let h = historyReducer(initHistory(e0), { type: "apply", edit: e1, at: 0 });
    h = historyReducer(h, { type: "undo" });
    const e3 = toggleCut(e0, "k2");
    h = historyReducer(h, { type: "apply", edit: e3, at: 10 });
    expect(h.future).toHaveLength(0);
    expect(h.past).toEqual([e0]);
  });

  it("skips no-op applies", () => {
    const h = initHistory(e0);
    expect(historyReducer(h, { type: "apply", edit: e0 })).toBe(h);
  });

  it("coalesces rapid changes with the same key into one undo step", () => {
    let h = initHistory(e0);
    const b1 = updateOverlay(e0, "o-g1", { brief: "c" });
    const b2 = updateOverlay(b1, "o-g1", { brief: "ca" });
    const b3 = updateOverlay(b2, "o-g1", { brief: "car" });
    h = historyReducer(h, { type: "apply", edit: b1, key: "brief:o-g1", at: 1000 });
    h = historyReducer(h, { type: "apply", edit: b2, key: "brief:o-g1", at: 1300 });
    h = historyReducer(h, { type: "apply", edit: b3, key: "brief:o-g1", at: 1600 });
    expect(h.past).toEqual([e0]);
    expect(h.present).toBe(b3);
    // a pause longer than the window starts a new step
    const b4 = updateOverlay(b3, "o-g1", { brief: "cars" });
    h = historyReducer(h, { type: "apply", edit: b4, key: "brief:o-g1", at: 1600 + COALESCE_MS + 1 });
    expect(h.past).toEqual([e0, b3]);
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(e0);
  });

  it("reset clears history", () => {
    let h = historyReducer(initHistory(e0), { type: "apply", edit: e1 });
    h = historyReducer(h, { type: "reset", edit: e2 });
    expect(h).toEqual({ past: [], present: e2, future: [] });
  });

  it("caps the undo stack", () => {
    let h = initHistory(e0);
    let cur = e0;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      cur = toggleCut(cur, "k1");
      h = historyReducer(h, { type: "apply", edit: cur, at: i * 10_000 });
    }
    expect(h.past.length).toBe(HISTORY_LIMIT);
  });
});

// ---------- timeline math ----------

describe("timeline math", () => {
  it("snaps to frames", () => {
    expect(snapToFrame(1.01, 30)).toBeCloseTo(1, 6);
    expect(snapToFrame(1.02, 30)).toBeCloseTo(31 / 30, 6);
    expect(snapMs(40, 25)).toBe(40);
    expect(snapMs(-1, 30)).toBe(0);
    expect(Object.is(snapMs(-1, 30), -0)).toBe(false);
  });

  it("zooms within bounds and keeps the anchor time in place", () => {
    expect(zoomStep(MAX_PPS, 1)).toBe(MAX_PPS);
    expect(zoomStep(MIN_PPS, -1)).toBe(MIN_PPS);
    expect(zoomStep(40, 1)).toBeCloseTo(50, 6);
    expect(fitZoom(100, 1000)).toBe(10);
    // time 20 s was at x = 300 px in view; after zooming to 50 px/s it must stay there
    expect(scrollForZoom(20, 300, 50)).toBe(700);
    expect(scrollForZoom(1, 300, 50)).toBe(0);
  });

  it("picks ruler steps at least ~90 px apart", () => {
    const { step, major } = rulerTicks(10, 0, 60);
    expect(step).toBe(10);
    expect(major).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(rulerTicks(400, 0, 1).step).toBeCloseTo(10 / 30, 6);
  });

  it("formats timecodes", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00");
    expect(formatTimecode(61.5, 30)).toBe("01:01:15");
    expect(formatTimecode(3723, 30)).toBe("1:02:03:00");
    expect(formatClock(75.4)).toBe("1:15");
    expect(formatClock(75.44, true)).toBe("1:15.4");
  });
});

// ---------- words, time map, placement ----------

const timeline: Timeline = {
  fps: 30,
  // c1 keeps the chosen retake (3.4–5.1), c2 keeps "Next" only when u1 is off… (both words here)
  segments: [
    { clipId: "c1", start: 3.4, end: 5.1, frames: 51, outStart: 0 },
    { clipId: "c2", start: 0.3, end: 1.4, frames: 33, outStart: 1.7 },
  ],
  duration: 2.8,
  overlays: [{ overlayId: "o-g1", cueId: "g1", start: 0.1, end: 1.6 }],
  chapters: [{ title: "Start", start: 0 }],
};

describe("words and the time map", () => {
  const idx = indexWords(readingOrder(transcript, ["c1", "c2"]));

  it("orders words by clip order then time", () => {
    const other = indexWords(readingOrder(transcript, ["c2", "c1"]));
    expect(other.order[0]!.id).toBe("w9");
    expect(idx.order.map((w) => w.id).slice(0, 3)).toEqual(["w0", "w1", "w2"]);
    expect(wordsBetween(idx, "w4", "w1").map((w) => w.id)).toEqual(["w1", "w2", "w3", "w4"]);
  });

  it("marks cut, restored and other-take words", () => {
    const st = wordStatuses(idx, baseEdit());
    expect(st.get("w2")).toEqual({ kind: "cut", cutId: "k1", reason: "filler" }); // enabled cut beats the unchosen take
    expect(st.get("w0")).toEqual({ kind: "alt", groupId: "tg1", option: 0 });
    expect(st.get("w5")).toEqual({ kind: "kept" });
    expect(st.get("w10")).toEqual({ kind: "restored", cutId: "u1", reason: "user" });
  });

  it("finds cuts with no words and places them after the word before", () => {
    const loose = wordlessCuts(idx, baseEdit());
    expect(loose.get("w4")!.map((c) => c.id)).toEqual(["k2"]);
  });

  it("breaks lines at sentence ends, pauses and clip changes", () => {
    const lines = toLines(idx.order);
    expect(lines.map((l) => l.words.map((w) => w.id).join(" "))).toEqual(["w0 w1 w2 w3 w4", "w5 w6 w7 w8", "w9 w10"]);
    expect(lines[2]!.clipStart).toBe(true);
  });

  it("maps source to output and back", () => {
    expect(sourceToOutput(timeline, "c1", 4.0)).toBeCloseTo(0.6, 6);
    expect(sourceToOutput(timeline, "c1", 1.0)).toBeNull();
    expect(sourceToOutput(timeline, "c2", 0.4)).toBeCloseTo(1.8, 6);
    expect(outputToSource(timeline, 1.8)).toEqual({ clipId: "c2", t: expect.closeTo(0.4, 6) });
  });

  it("gives output times for the words that play, and the word at a time", () => {
    const times = wordOutputTimes(timeline, idx.order);
    expect(times.map((t) => t.id)).toEqual(["w5", "w6", "w7", "w8", "w9", "w10"]);
    expect(wordAt(times, 0.15)).toBe("w5");
    expect(wordAt(times, 0.5)).toBe("w6");
    expect(wordAt(times, -1)).toBeNull();
  });
});

describe("placement", () => {
  const idx = indexWords(readingOrder(transcript, ["c1", "c2"]));
  const times = wordOutputTimes(timeline, idx.order);

  it("uses the side rule from the schema", () => {
    expect(overlaySide({}, "left")).toBe("right");
    expect(overlaySide({}, "right")).toBe("left");
    expect(overlaySide({}, "center")).toBe("right");
    expect(overlaySide({ side: "left" }, "left")).toBe("left");
  });

  it("uses the server placement, shifted by an unsaved nudge", () => {
    const basis = baseEdit();
    const saved = placeOverlays(basis, timeline, basis, idx, times).find((p) => p.overlayId === "o-g1")!;
    expect(saved).toMatchObject({ start: 0.1, end: 1.6, estimated: false, enabled: true });
    const nudged = nudgeOverlay(basis, "o-g1", 200, 30);
    const p = placeOverlays(nudged, timeline, basis, idx, times).find((x) => x.overlayId === "o-g1")!;
    expect(p.start).toBeCloseTo(0.3, 2);
    expect(p.end).toBeCloseTo(1.8, 2); // a nudge moves the whole graphic (same length), matching the server
    expect(p.estimated).toBe(true);
    const fixed = setOverlayDuration(basis, "o-g1", 1000, 30);
    const q = placeOverlays(fixed, timeline, basis, idx, times).find((x) => x.overlayId === "o-g1")!;
    expect(q.end - q.start).toBeCloseTo(1, 6);
  });

  it("estimates disabled overlays from their words", () => {
    const basis = baseEdit();
    const p = placeOverlays(basis, timeline, basis, idx, times).find((x) => x.overlayId === "o-g2")!;
    expect(p.enabled).toBe(false);
    expect(p.start).toBeCloseTo(1.8, 6);
  });

  it("explains each segment join", () => {
    const tl: Timeline = {
      ...timeline,
      segments: [
        { clipId: "c1", start: 0.4, end: 1.05, frames: 20, outStart: 0 },
        { clipId: "c1", start: 1.45, end: 2.6, frames: 34, outStart: 20 / 30 },
        { clipId: "c2", start: 0.3, end: 1.4, frames: 33, outStart: 54 / 30 },
      ],
    };
    const e = chooseTake(baseEdit(), "tg1", 0);
    const joins = segmentJoins(tl, e, idx);
    expect(joins).toHaveLength(2);
    expect(joins[0]).toMatchObject({ clipChange: false, reasons: ["filler"], cutIds: ["k1"] });
    expect(joins[0]!.removed).toBeCloseTo(0.4, 6);
    expect(joins[1]).toMatchObject({ clipChange: true });
  });
});

// ---------- the ?mock=1 fixture stays coherent ----------


describe("mock fixture", () => {
  const fx = buildMockFixture("what-is-an-ai-engineer");
  const tl = mockTimeline(fx.edit, fx.transcript, fx.project.clips, 30);

  it("has the shapes the review screen needs", () => {
    expect(fx.transcript.words.length).toBeGreaterThan(200);
    expect(new Set(fx.transcript.words.map((w) => w.id)).size).toBe(fx.transcript.words.length);
    expect(fx.edit.takeGroups.filter((g) => g.options.length > 1)).toHaveLength(2);
    expect(fx.edit.overlays).toHaveLength(4);
    expect(fx.edit.overlays.some((o) => o.layout === "split")).toBe(true);
    expect(new Set(fx.edit.cuts.map((c) => c.reason)).size).toBeGreaterThanOrEqual(6);
    expect(fx.candidates.missing.length).toBeGreaterThan(0);
  });

  it("compiles to a timeline with the enabled overlays and every chapter", () => {
    expect(tl.segments.length).toBeGreaterThan(5);
    expect(tl.duration).toBeGreaterThan(60);
    expect(tl.overlays.map((o) => o.overlayId).sort()).toEqual(["o-g1", "o-g2", "o-r1"]);
    expect(tl.chapters).toHaveLength(3);
    expect(tl.chapters[0]!.start).toBe(0);
    for (let i = 1; i < tl.segments.length; i++) {
      const a = tl.segments[i - 1]!;
      expect(tl.segments[i]!.outStart).toBeCloseTo(a.outStart + a.frames / 30, 6);
    }
  });

  it("drops an unchosen take from the cut and plays the chosen one", () => {
    const idx = indexWords(readingOrder(fx.transcript, fx.edit.clipOrder));
    const times = new Set(wordOutputTimes(tl, idx.order).map((t) => t.id));
    const g = fx.edit.takeGroups.find((x) => x.options.length === 3)!;
    expect(times.has(g.options[g.chosen]!.startWordId)).toBe(true);
    expect(times.has(g.options[0]!.startWordId)).toBe(false);
    const swapped = mockTimeline(chooseTake(fx.edit, g.id, 2), fx.transcript, fx.project.clips, 30);
    const times2 = new Set(wordOutputTimes(swapped, idx.order).map((t) => t.id));
    expect(times2.has(g.options[2]!.startWordId)).toBe(true);
    expect(times2.has(g.options[1]!.startWordId)).toBe(false);
  });
});

describe("take numbering", () => {
  it("numbers takes in recording order, not storage order", async () => {
    const { takeNumber, takesInRecordingOrder } = await import("../web/src/lib/takes.ts");
    const opt = (clipId: string, start: number) => ({ clipId, start, end: start + 1, startWordId: "w", endWordId: "w" });
    const group = { options: [opt("c1", 16), opt("c1", 10), opt("c2", 1)] }; // Claude's pick (16 s) stored first
    expect(takesInRecordingOrder(group)).toEqual([1, 0, 2]);
    expect(takeNumber(group, 0)).toBe(2);
    expect(takeNumber(group, 1)).toBe(1);
    expect(takeNumber(group, 2)).toBe(3);
  });
});
