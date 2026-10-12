import { describe, expect, it } from "vitest";
import { refineSpan, valley, type Envelope } from "../src/media/energy.ts";
import { refineFillerTokens } from "../src/transcribe/refine.ts";

// 10 ms hop envelope: loud speech with a quiet dip at 0.50 s and another at 0.90 s
const env = (): Envelope => {
  const rms = new Float32Array(150).fill(0.3);
  for (const i of [49, 50, 51]) rms[i] = 0.01;
  for (const i of [89, 90, 91]) rms[i] = 0.02;
  return { hop: 0.01, rms };
};

describe("energy valleys", () => {
  it("finds the quietest point in a window", () => {
    expect(valley(env(), 0.4, 0.6)).toBeCloseTo(0.505, 3);
  });
  it("moves a filler cut's edges to the dips around it", () => {
    // ASR stamped the "uh" at 0.56–0.82; the real gaps are at ~0.50 and ~0.90
    const r = refineSpan(env(), 0.56, 0.82, 0.3, 1.2);
    expect(r.start).toBeGreaterThanOrEqual(0.49); // inside the dip at 0.49–0.52 (nearest equal point to the stamp)
    expect(r.start).toBeLessThanOrEqual(0.52);
    expect(r.end).toBeGreaterThanOrEqual(0.89); // inside the dip at 0.89–0.92
    expect(r.end).toBeLessThanOrEqual(0.92);
  });
  it("never reaches past the neighbours' safe zones", () => {
    const r = refineSpan(env(), 0.56, 0.82, 0.55, 0.85);
    expect(r.start).toBeGreaterThanOrEqual(0.55);
    expect(r.end).toBeLessThanOrEqual(0.85 + 0.01);
  });
  it("refines filler words and keeps neighbours from overlapping them", () => {
    const words = [
      { id: "w0", clipId: "c1", text: "two", start: 0.1, end: 0.56 },
      { id: "w1", clipId: "c1", text: "uh", start: 0.56, end: 0.82 },
      { id: "w2", clipId: "c1", text: "jobs", start: 0.82, end: 1.3 },
    ];
    const fillers = [{ id: "f0", clipId: "c1", start: 0.56, end: 0.82, kind: "token" as const, wordId: "w1" }];
    const out = refineFillerTokens(words, fillers, new Map([["c1", env()]]));
    const [a, b, c] = out.words;
    expect(b!.start).toBeGreaterThanOrEqual(0.49);
    expect(b!.start).toBeLessThanOrEqual(0.52);
    expect(b!.end).toBeGreaterThanOrEqual(0.89);
    expect(b!.end).toBeLessThanOrEqual(0.92);
    expect(a!.end).toBeLessThanOrEqual(b!.start);
    expect(c!.start).toBeGreaterThanOrEqual(b!.end);
    expect(out.fillers[0]).toMatchObject({ start: b!.start, end: b!.end });
  });
});
