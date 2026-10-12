import { describe, expect, it } from "vitest";
import { ConfigSchema, type Edit, type Transcript, type Word } from "../src/core/schema.ts";
import { buildTimeline } from "../src/core/timeline.ts";
import { planSweepCuts } from "../src/transcribe/sweep.ts";

// "So the tool [uh] searches and finds it." — Parakeet's first pass folded the "uh" into a gap it
// didn't flag, so nothing cut it; the listen-back hears it at 1.0–1.3 s of the edited audio.
const words: Word[] = [
  { id: "w0", clipId: "c1", text: "So", start: 0.0, end: 0.2 },
  { id: "w1", clipId: "c1", text: "the", start: 0.25, end: 0.4 },
  { id: "w2", clipId: "c1", text: "tool", start: 0.45, end: 0.9 },
  { id: "w3", clipId: "c1", text: "searches", start: 1.4, end: 1.9 },
  { id: "w4", clipId: "c1", text: "and", start: 1.95, end: 2.1 },
];
const transcript: Transcript = { engine: "t", model: "t", words, silences: [], fillers: [] };
const clip = { id: "c1", name: "c1", path: "/x", duration: 3, width: 1920, height: 1080, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false };
const config = ConfigSchema.parse({ edit: { maxPauseMs: 1000 } });
const editOf = (over: Partial<Edit> = {}): Edit => ({ version: 1, clipOrder: ["c1"], cuts: [], takeGroups: [], overlays: [], chapters: [], intro: true, outro: true, ...over });
const heard = [{ start: 1.0, end: 1.3 }];

describe("planSweepCuts", () => {
  it("cuts a filler that is still audible in the edited audio", () => {
    const edit = editOf();
    const tl = buildTimeline(edit, transcript, [clip], config);
    const { cuts } = planSweepCuts(heard, tl, transcript, edit, new Map());
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ clipId: "c1", reason: "filler", by: "auto", enabled: true });
    expect(cuts[0]!.start).toBeGreaterThanOrEqual(0.9);
    expect(cuts[0]!.end).toBeLessThanOrEqual(1.4);
  });

  it("still sweeps inside an ad-lib Claude chose to keep (that keeps the words, not the ums)", () => {
    const edit = editOf({ cuts: [{ id: "a1", clipId: "c1", start: 0, end: 2.1, reason: "adlib", by: "claude", enabled: false }] });
    const tl = buildTimeline(edit, transcript, [clip], config);
    expect(planSweepCuts(heard, tl, transcript, edit, new Map()).cuts).toHaveLength(1);
  });

  it("respects a filler someone chose to keep, and the user's own cuts", () => {
    for (const c of [
      { id: "k1", clipId: "c1", start: 0.95, end: 1.35, reason: "filler" as const, by: "claude" as const, enabled: false },
      { id: "k2", clipId: "c1", start: 0.95, end: 1.35, reason: "user" as const, by: "user" as const, enabled: false },
    ]) {
      const edit = editOf({ cuts: [c] });
      const tl = buildTimeline(edit, transcript, [clip], config);
      expect(planSweepCuts(heard, tl, transcript, edit, new Map()).cuts).toHaveLength(0);
    }
  });

  it("never cuts into a kept word", () => {
    const edit = editOf();
    const tl = buildTimeline(edit, transcript, [clip], config);
    // a "filler" heard over the middle of "searches" (1.4–1.9) must not become a cut
    expect(planSweepCuts([{ start: 1.5, end: 1.8 }], tl, transcript, edit, new Map()).cuts).toHaveLength(0);
  });
});

describe("redundant sweep cuts", () => {
  it("skips a filler fragment that mostly sits inside a cut that's already on", () => {
    const edit = editOf({ cuts: [{ id: "k1", clipId: "c1", start: 0.92, end: 1.38, reason: "filler", by: "auto", enabled: true }] });
    const tl = buildTimeline(edit, transcript, [clip], config);
    // the fragment heard at the join maps back around the existing cut
    const { cuts } = planSweepCuts([{ start: 0.85, end: 0.95 }], tl, transcript, edit, new Map());
    expect(cuts).toHaveLength(0);
  });
});
