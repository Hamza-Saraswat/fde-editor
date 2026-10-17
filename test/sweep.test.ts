import { describe, expect, it } from "vitest";
import { ConfigSchema, type Edit, type Transcript, type Word } from "../src/core/schema.ts";
import type { Envelope } from "../src/media/energy.ts";
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

// Real take (real-voice-check), the three ums the first sweep left in. 10 ms envelope helper:
// `spans` are [from, to, level] in seconds, everything else is near-silent.
const envOf = (dur: number, spans: [number, number, number][]): Envelope => {
  const rms = new Float32Array(Math.ceil(dur / 0.01)).fill(0.002);
  for (const [a, b, v] of spans) for (let i = Math.round(a / 0.01); i < Math.round(b / 0.01); i++) rms[i] = v;
  return { hop: 0.01, rms, speech: 0.3 };
};

describe("listen-back placement on a real take", () => {
  it("an uh that runs straight on from the word before it is cut where the re-listen heard it start", () => {
    // "family [uh] acquired": voice never stops between "family" and "uh"; Parakeet stamped "family"
    // over both (0.69–1.21) and put a stray "uh" token in the quiet after it. The listen-back heard
    // "family," end at 1.10 and "acquired" start at 1.33 (source seconds, no cuts before them here).
    const ws: Word[] = [
      { id: "a0", clipId: "c1", text: "family", start: 0.69, end: 1.21 },
      { id: "a1", clipId: "c1", text: "acquired", start: 1.65, end: 2.29 },
    ];
    const tr: Transcript = { engine: "t", model: "t", words: ws, silences: [], fillers: [] };
    const env = envOf(3, [[0.67, 1.21, 0.25], [1.65, 2.29, 0.3]]);
    const edit = editOf();
    const tl = buildTimeline(edit, tr, [clip], config);
    const at = (src: number) => src - tl.segments[0]!.start;
    const { cuts } = planSweepCuts([{ start: at(1.10), end: at(1.26), prevEnd: at(1.10), nextStart: at(1.65) }], tl, tr, edit, new Map([["c1", env]]));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.start).toBeGreaterThanOrEqual(1.10 - 1e-9); // not into "family" as the re-listen heard it
    expect(cuts[0]!.end).toBeGreaterThanOrEqual(1.21); // takes the whole voiced tail
    // and the timeline really drops it: the cut wins over the word's sloppy stamp
    const after = buildTimeline({ ...edit, cuts }, tr, [clip], config);
    expect(after.segments.some((s) => s.start < 1.2 && s.end > 1.2)).toBe(false);
  });

  it("a filler heard across a join is placed on the side that has the voice", () => {
    // "show [pause, cut down] it's": the join plays 0.86–1.06 of silence, then 2.28–2.48 with a voiced
    // "uh" at 2.32–2.45 in front of "it's".
    const ws: Word[] = [
      { id: "b0", clipId: "c1", text: "show", start: 0.52, end: 0.84 },
      { id: "b1", clipId: "c1", text: "it's", start: 2.5, end: 2.9 },
    ];
    const tr: Transcript = { engine: "t", model: "t", words: ws, silences: [], fillers: [] };
    const env = envOf(3, [[0.5, 0.84, 0.3], [2.32, 2.45, 0.25], [2.5, 2.9, 0.3]]);
    const edit = editOf();
    const tl = buildTimeline(edit, tr, [clip], ConfigSchema.parse({}));
    expect(tl.segments).toHaveLength(2);
    const join = tl.segments[1]!.outStart;
    const { cuts } = planSweepCuts([{ start: join - 0.08, end: join + 0.16, prevEnd: join - 0.2, nextStart: join + 0.22 }], tl, tr, edit, new Map([["c1", env]]));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.start).toBeGreaterThan(2);
    expect(cuts[0]!.end).toBeLessThanOrEqual(2.5);
  });

  it("ignores a filler the re-listen 'heard' in silence or a lip click", () => {
    const tr: Transcript = { engine: "t", model: "t", words, silences: [], fillers: [] };
    const env = envOf(3, [[0, 0.2, 0.3], [0.25, 0.4, 0.3], [0.45, 0.9, 0.3], [1.15, 1.17, 0.2], [1.4, 2.1, 0.3]]);
    const edit = editOf();
    const tl = buildTimeline(edit, tr, [clip], config);
    expect(planSweepCuts(heard, tl, tr, edit, new Map([["c1", env]])).cuts).toHaveLength(0);
  });

  it("extends a cut that left the end of an uh behind", () => {
    // "more. [uh] One,": an earlier cut took 0.24–0.47 of an uh voiced 0.28–0.50; "One" starts at 0.58
    const ws: Word[] = [
      { id: "c0", clipId: "c1", text: "more.", start: 0.0, end: 0.2 },
      { id: "c1w", clipId: "c1", text: "One,", start: 0.36, end: 0.84 },
    ];
    const tr: Transcript = { engine: "t", model: "t", words: ws, silences: [], fillers: [] };
    const env = envOf(3, [[0.0, 0.2, 0.3], [0.28, 0.5, 0.3], [0.58, 0.84, 0.3]]);
    const prior = { id: "ks1", clipId: "c1", start: 0.24, end: 0.47, reason: "filler" as const, by: "auto" as const, enabled: true };
    const edit = editOf({ cuts: [prior] });
    const tl = buildTimeline(edit, tr, [clip], config);
    const seg = tl.segments.find((s) => s.start > 0.3)!;
    expect(seg.start).toBeGreaterThanOrEqual(0.46); // the cut now wins over "One,"'s early stamp (0.36)
    const { cuts } = planSweepCuts([{ start: seg.outStart - 0.02, end: seg.outStart + 0.02, prevEnd: seg.outStart - 0.3, nextStart: seg.outStart + 0.1 }], tl, tr, edit, new Map([["c1", env]]));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.end).toBeGreaterThanOrEqual(0.5);
    expect(cuts[0]!.end).toBeLessThanOrEqual(0.58);
  });

  it("doesn't trust an early word stamp from the re-listen when there is a gap to cut at", () => {
    // same "more. [uh] One," — the re-listen stamped "one," 0.1 s early, inside the uh (real take)
    const ws: Word[] = [
      { id: "d0", clipId: "c1", text: "more.", start: 0.0, end: 0.2 },
      { id: "d1", clipId: "c1", text: "One,", start: 0.36, end: 0.84 },
    ];
    const tr: Transcript = { engine: "t", model: "t", words: ws, silences: [], fillers: [] };
    const env = envOf(3, [[0.0, 0.2, 0.3], [0.28, 0.5, 0.3], [0.58, 0.84, 0.3]]);
    const edit = editOf();
    const tl = buildTimeline(edit, tr, [clip], config);
    const at = (src: number) => src - tl.segments[0]!.start;
    const { cuts } = planSweepCuts([{ start: at(0.3), end: at(0.4), prevEnd: at(0.2), nextStart: at(0.4) }], tl, tr, edit, new Map([["c1", env]]));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.end).toBeGreaterThanOrEqual(0.5);
  });
});
