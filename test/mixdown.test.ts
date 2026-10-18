import { describe, expect, it } from "vitest";
import type { Timeline } from "../src/core/schema.ts";
import { crossfadePieces, mixPiece, planPieces, type Piece } from "../src/media/mixdown.ts";

const FPS = 30;
const timelineOf = (segs: [number, number][]): Timeline => {
  let out = 0;
  const segments = segs.map(([start, end]) => {
    const frames = Math.round((end - start) * FPS);
    const s = { clipId: "c1", start, end, frames, outStart: out / FPS };
    out += frames;
    return s;
  });
  return { fps: FPS, segments, duration: out / FPS, overlays: [], chapters: [] };
};

// deterministic white noise "source", stereo interleaved, long enough for every piece
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
const source = Int16Array.from({ length: 48000 * 4 * 2 }, () => Math.round(rand() * 8000));
const read = (p: Piece) => source.slice((p.s0 - p.lead) * 2, (p.s1 + p.trail) * 2);
const rms = (a: Int16Array, from: number, to: number) => {
  let s = 0;
  for (let i = from * 2; i < to * 2; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / ((to - from) * 2));
};

describe("crossfaded mixdown", () => {
  const tl = timelineOf([[0.5, 1.0], [1.4, 2.0], [2.6, 3.0]]);
  const pieces = planPieces(tl, 30);

  it("shares a 15 ms handle across each join and none at the ends", () => {
    expect(pieces.map((p) => [p.lead, p.trail])).toEqual([[0, 720], [720, 720], [720, 0]]);
    expect(pieces[0]).toMatchObject({ s0: 24000, s1: 48000 });
  });

  it("is exactly as long as the video, sample for sample", () => {
    const mix = crossfadePieces(pieces, pieces.map(read), 720);
    expect(mix.length / 2).toBe((tl.duration * 48000));
  });

  it("leaves the audio between joins untouched", () => {
    const mix = crossfadePieces(pieces, pieces.map(read), 720);
    // 0.2 s into the first piece = source 0.7 s
    for (let k = 0; k < 200; k++) expect(mix[(9600 + k) * 2]).toBe(source[(33600 + k) * 2]);
  });

  it("keeps the level steady through a cut instead of dipping", () => {
    const mix = crossfadePieces(pieces, pieces.map(read), 720);
    const join = 24000; // first join, in output samples
    const body = rms(mix, 4000, 20000);
    const atJoin = rms(mix, join - 720, join + 720);
    expect(20 * Math.log10(atJoin / body)).toBeGreaterThan(-1.5); // the old 30 ms fade-out/fade-in pair: about −11 dB over this window
  });

  it("refuses mismatched handles", () => {
    const p: Piece = { clipId: "c1", s0: 0, s1: 4800, lead: 720, trail: 0 };
    expect(() => mixPiece(p, new Int16Array((4800 + 720) * 2), new Float32Array(0), { first: false, last: true, fade: 720 })).toThrow(/handles/);
  });
});

describe("exact audio edges", () => {
  it("silences what the frame grid added past the cut, and keeps the rest untouched", () => {
    const tl = timelineOf([[0.5, 1.0]]);
    const p = planPieces(tl, 30)[0]!;
    p.a1 = p.s1 - 1440; // the real cut is 30 ms before the frame boundary (a widened sliver of a cut word)
    const mix = crossfadePieces([p], [read(p)], 720);
    const tail = mix.slice((p.a1 - p.s0 + 200) * 2, (p.s1 - p.s0 - 720) * 2); // past the 4 ms ramp, before the edge fade
    expect(tail.length).toBeGreaterThan(500);
    expect(Math.max(...Array.from(tail, Math.abs))).toBe(0);
    expect(mix[(p.a1 - p.s0 - 10) * 2]).toBe(source[(p.a1 - 10) * 2]); // up to the cut, the audio is as recorded
    for (let k = 4000; k < 4200; k++) expect(mix[k * 2]).toBe(source[(p.s0 + k) * 2]); // middle untouched
  });
});
