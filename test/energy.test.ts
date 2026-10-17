import { describe, expect, it } from "vitest";
import { refineSpan, valley, voicedCore, type Envelope } from "../src/media/energy.ts";
import { refineFillerTokens } from "../src/transcribe/refine.ts";

// 10 ms hop envelope: loud speech with a quiet dip at 0.50 s and another at 0.90 s
const env = (): Envelope => {
  const rms = new Float32Array(150).fill(0.3);
  for (const i of [49, 50, 51]) rms[i] = 0.01;
  for (const i of [89, 90, 91]) rms[i] = 0.02;
  return { hop: 0.01, rms, speech: 0.3 };
};

// "two [pause] uh [pause] jobs": speech 0.10–0.40, quiet 0.40–0.55, voiced "uh" 0.55–0.80,
// quiet 0.80–0.95, speech 0.95–1.30. ASR stamped the "uh" sloppily at 0.50–0.90.
const speechEnv = (): Envelope => {
  const rms = new Float32Array(150).fill(0.002);
  for (let i = 10; i < 40; i++) rms[i] = 0.3;
  for (let i = 55; i < 80; i++) rms[i] = 0.2;
  for (let i = 95; i < 130; i++) rms[i] = 0.3;
  return { hop: 0.01, rms, speech: 0.3 };
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
  it("cuts only the voiced part of an uh, keeping the natural pauses around it", () => {
    const r = voicedCore(speechEnv(), 0.5, 0.9, 0.25, 1.1);
    expect(r.start).toBeGreaterThanOrEqual(0.5); // not before the "uh" starts (0.55 − 30 ms)
    expect(r.start).toBeLessThanOrEqual(0.55);
    expect(r.end).toBeGreaterThanOrEqual(0.8); // covers the whole "uh"
    expect(r.end).toBeLessThanOrEqual(0.85); // and leaves most of the 0.80–0.95 pause
  });

  it("refines filler words to their voiced core and keeps neighbours from overlapping them", () => {
    const words = [
      { id: "w0", clipId: "c1", text: "two", start: 0.1, end: 0.5 },
      { id: "w1", clipId: "c1", text: "uh", start: 0.5, end: 0.9 },
      { id: "w2", clipId: "c1", text: "jobs", start: 0.9, end: 1.3 },
    ];
    const fillers = [{ id: "f0", clipId: "c1", start: 0.5, end: 0.9, kind: "token" as const, wordId: "w1" }];
    const out = refineFillerTokens(words, fillers, new Map([["c1", speechEnv()]]));
    const [a, b, c] = out.words;
    expect(b!.start).toBeGreaterThanOrEqual(0.5);
    expect(b!.end).toBeLessThanOrEqual(0.85);
    expect(a!.end).toBeLessThanOrEqual(b!.start);
    expect(c!.start).toBeGreaterThanOrEqual(b!.end);
    expect(out.fillers[0]).toMatchObject({ start: b!.start, end: b!.end });
  });
});
