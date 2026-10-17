import { describe, expect, it } from "vitest";
import { ConfigSchema, type Cut, type Edit, type Transcript, type Word } from "../src/core/schema.ts";
import { buildTimeline, sourceToOutput } from "../src/core/timeline.ts";
import { findLeftovers, insertedTokens } from "../src/transcribe/leftovers.ts";

// Real take (what-is-an-ai-engineer-v2): "Then you know you can look at the rest". Claude cut "you know"
// on Parakeet's stamps, but the phrase runs straight on from "Then", so the cut kept part of it and the
// listen-back still heard "you know" at the join.
const w = (id: string, text: string, start: number, end: number): Word => ({ id, clipId: "c1", text, start, end });
const words = [
  w("w0", "development", 0.2, 0.7), w("w1", "velocity.", 0.7, 1.2),
  w("w2", "Then", 2.53, 2.6), w("w3", "you", 2.68, 2.76), w("w4", "know", 2.76, 2.84),
  w("w5", "you", 2.92, 3.0), w("w6", "can", 3.0, 3.16), w("w7", "look", 3.16, 3.32), w("w8", "at", 3.32, 3.4), w("w9", "the", 3.4, 3.5), w("w10", "rest", 3.5, 3.9),
];
const transcript: Transcript = { engine: "t", model: "t", words, silences: [], fillers: [] };
const clip = { id: "c1", name: "c1", path: "/x", duration: 6, width: 1920, height: 1080, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false };
const config = ConfigSchema.parse({});
const cut = (over: Partial<Cut> = {}): Cut => ({ id: "k11", clipId: "c1", start: 2.68, end: 2.84, reason: "filler", by: "claude", enabled: true, ...over });
const editOf = (cuts: Cut[]): Edit => ({ version: 1, clipOrder: ["c1"], cuts, takeGroups: [], overlays: [], chapters: [], intro: true, outro: true });

/** What the re-listen hears: every kept word at its output time, plus extra words at a given output time. */
function heardWith(edit: Edit, extra: string[]) {
  const tl = buildTimeline(edit, transcript, [clip], config);
  const out = words.filter((x) => !(x.start >= 2.68 && x.end <= 2.84)).map((x) => ({ text: x.text, start: sourceToOutput(tl, "c1", (x.start + x.end) / 2) ?? 0, end: (sourceToOutput(tl, "c1", (x.start + x.end) / 2) ?? 0) + 0.05 }));
  const join = tl.segments.find((x) => x.start >= 2.8)?.outStart ?? 0; // the join at the cut, not the pause before "Then"
  const at = out.findIndex((x) => x.text === "you");
  out.splice(at, 0, ...extra.map((text, i) => ({ text, start: join + 0.02 * i, end: join + 0.02 * i + 0.02 })));
  return { tl, heard: out };
}

describe("listen-back: cuts that chopped through speech", () => {
  it("finds a cut whose words are still heard at its join", () => {
    const edit = editOf([cut()]);
    const { tl, heard } = heardWith(edit, ["you", "know"]);
    expect(tl.segments.length).toBeGreaterThan(1);
    expect(findLeftovers(heard, tl, transcript, edit)).toEqual([expect.objectContaining({ cutId: "k11", heard: "you know" })]);
  });

  it("leaves a cut alone when the join sounds clean", () => {
    const edit = editOf([cut()]);
    const { tl, heard } = heardWith(edit, []);
    expect(findLeftovers(heard, tl, transcript, edit)).toEqual([]);
  });

  it("ignores a single stray word (as likely the recogniser as a leftover)", () => {
    const edit = editOf([cut()]);
    const { tl, heard } = heardWith(edit, ["know"]);
    expect(findLeftovers(heard, tl, transcript, edit)).toEqual([]);
  });

  it("never touches a cut the user made", () => {
    const edit = editOf([cut({ by: "user", reason: "user" })]);
    const { tl, heard } = heardWith(edit, ["you", "know"]);
    expect(findLeftovers(heard, tl, transcript, edit)).toEqual([]);
  });

  it("aligns heard words to expected ones and marks only the extras", () => {
    const ins = insertedTokens(["then", "you", "can"], ["then", "you", "know", "you", "can"]);
    expect(ins.filter(Boolean)).toHaveLength(2); // "you know" or "know you": the same two extras either way
    expect(ins[0]).toBe(false);
    expect(ins[2]).toBe(true);
    expect(ins[4]).toBe(false);
  });
});
