import { describe, expect, it } from "vitest";
import { motionOf, motionSpans, parseYdif } from "../src/media/motion.ts";

describe("picture motion", () => {
  it("reads per-frame YDIF from ffmpeg's metadata print", () => {
    const out = "frame:0    pts:0       pts_time:0\nlavfi.signalstats.YDIF=0.000000\nframe:1    pts:512     pts_time:0.0333\nlavfi.signalstats.YDIF=1.250000\n";
    expect(parseYdif(out)).toEqual([0, 1.25]);
  });

  it("finds a reach (many times the clip's usual motion, long enough), bridging the arm going out and back", () => {
    // 8:10 of Video 1 v2 in miniature: 0.5 baseline, a reach, a short lull, then the pause/resume frame
    const v = new Array(150).fill(0.5);
    for (let i = 60; i < 80; i++) v[i] = 5;
    v[95] = 30;
    const spans = motionSpans(motionOf(v, 30), 4, 9, 0.6);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBeCloseTo(2, 2);
    expect(spans[0]!.end).toBeCloseTo(96 / 30, 2);
  });

  it("ignores a short jolt (a hand hitting the table)", () => {
    const v = new Array(150).fill(0.5);
    for (let i = 60; i < 64; i++) v[i] = 5;
    expect(motionSpans(motionOf(v, 30), 4, 9, 0.6)).toHaveLength(0);
  });
});
