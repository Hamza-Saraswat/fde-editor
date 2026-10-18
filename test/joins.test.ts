import { describe, expect, it } from "vitest";
import { applyJoins, BREATHE_MS, skeleton } from "../src/core/joins.ts";
import { normalizeWords } from "../src/core/normalize.ts";
import { ConfigSchema, type Cut, type Edit, type ScriptDoc, type Transcript, type Word } from "../src/core/schema.ts";
import { resolveStyle } from "../src/core/style.ts";
import { buildTimeline, keptWordIds } from "../src/core/timeline.ts";
import type { Envelope } from "../src/media/energy.ts";

// Each case is one of the joins Hamza flagged in the full Video 1 v2 cut, rebuilt from its word stamps.
const config = ConfigSchema.parse({});
const style = resolveStyle(config);
let n = 0;
const words = (spec: [string, number, number][]): Word[] => spec.map(([text, start, end]) => ({ id: `w${n++}`, clipId: "c1", text, start, end }));
/** 10 ms envelope: `voiced` spans at speech level, near-silence elsewhere. */
const envOf = (voiced: [number, number][], dur = 8): Envelope => {
  const rms = new Float32Array(Math.ceil(dur / 0.01)).fill(0.002);
  for (const [a, b] of voiced) for (let i = Math.round(a / 0.01); i < Math.round(b / 0.01); i++) rms[i] = 0.3;
  return { hop: 0.01, rms, speech: 0.3 };
};
const scriptOf = (...sentences: string[]): ScriptDoc => ({
  title: "t", sections: [{ id: "sec0", title: "s", level: 2, sentenceIds: sentences.map((_, i) => `s0.${i + 1}`) }],
  sentences: sentences.map((text, i) => ({ id: `s0.${i + 1}`, sectionId: "sec0", blockId: "b0.1", text, tokens: normalizeWords(text) })), cues: [],
});
const cut = (id: string, start: number, end: number, reason: Cut["reason"], over: Partial<Cut> = {}): Cut =>
  ({ id, clipId: "c1", start, end, reason, by: "claude", enabled: true, ...over });
function setup(ws: Word[], cuts: Cut[], sentenceIds = ["s0.1"]): { edit: Edit; transcript: Transcript } {
  const transcript: Transcript = { engine: "t", model: "t", words: ws, silences: [], fillers: [] };
  const option = { clipId: "c1", startWordId: ws[0]!.id, endWordId: ws.at(-1)!.id, start: ws[0]!.start, end: ws.at(-1)!.end, score: 1 };
  const edit: Edit = { version: 1, clipOrder: ["c1"], cuts, takeGroups: [{ id: "t1", sentenceIds, options: [option], chosen: 0, why: "" }], overlays: [], chapters: [], intro: true, outro: true };
  return { edit, transcript };
}
const keptText = (e: Edit, t: Transcript) => { const k = keptWordIds(e, t); return t.words.filter((w) => k.has(w.id)).map((w) => w.text).join(" "); };
const voicedAll = (ws: Word[]): [number, number][] => ws.map((w) => [w.start, w.end]);

describe("phonetic skeleton", () => {
  it("matches a misheard word to its script word", () => {
    expect(skeleton("clod")).toBe(skeleton("Claude"));
    expect(skeleton("Tomorrow")).toBe(skeleton("Tomoro"));
    expect(skeleton("claw")).not.toBe(skeleton("Claude"));
  });
});

describe("join pass on the six flagged joins", () => {
  it("3:01 — a false start takes the 'uh' before the restart with it", () => {
    const ws = words([["are", 0, 0.2], ["mostly", 0.2, 0.5], ["coming", 0.6, 0.9], ["from", 0.9, 1.1], ["software", 1.3, 1.6], ["engineering", 1.6, 2.0], ["data,", 2.0, 2.3], ["uh", 2.33, 2.5], ["software", 2.7, 3.0], ["engineering,", 3.0, 3.4], ["data", 3.5, 3.7], ["science,", 3.7, 4.1]]);
    const { edit, transcript } = setup(ws, [cut("k12", 1.3, 2.3, "false-start"), cut("k87", 2.33, 2.5, "filler", { by: "auto", enabled: false, wanted: true })]);
    const out = applyJoins(edit, { transcript, script: scriptOf("People moving into it are mostly coming from software engineering, data science, and full stack work."), envelopes: new Map([["c1", envOf(voicedAll(ws))]]), style });
    expect(keptText(out, transcript)).toBe("are mostly coming from software engineering, data science,");
    expect(out.cuts.find((c) => c.id === "k12")!.end).toBeGreaterThanOrEqual(2.5);
  });

  it("'code plan' — a stumble keeps the last attempt at a script word the transcriber misheard", () => {
    const ws = words([["dollar", 0, 0.3], ["a", 0.3, 0.4], ["month", 0.4, 0.8], ["claw", 0.9, 1.1], ["uh", 1.1, 1.3], ["claw", 1.4, 1.6], ["clod", 1.7, 2.0], ["code", 2.0, 2.3], ["plan", 2.3, 2.6]]);
    const { edit, transcript } = setup(ws, [cut("k25", 0.9, 2.0, "stumble")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("You do not need a two hundred dollar a month Claude Code plan."), envelopes: new Map([["c1", envOf(voicedAll(ws))]]), style });
    expect(keptText(out, transcript)).toBe("dollar a month clod code plan");
  });

  it("2:34 — a slurred sentence ending is never trimmed off", () => {
    const ws = words([["same", 0, 0.2], ["companies", 0.2, 0.7], ["held", 0.7, 0.9], ["steady", 0.9, 1.3], ["for.", 1.3, 1.5], ["Growth.", 1.5, 2.0], ["Two,", 2.0, 2.3], ["the", 2.3, 2.4], ["job", 2.4, 2.7]]);
    const { edit, transcript } = setup(ws, [cut("k9", 1.3, 2.0, "stumble")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("Experienced developers at the same companies held steady or grew.", "Two, the job isn't going anywhere."), envelopes: new Map([["c1", envOf([[0, 2.7]])]]), style });
    expect(out.cuts[0]!.enabled).toBe(false);
  });

  it("2:41 — a wrong number corrected mid-sentence stays cut, with a beat of quiet at the join", () => {
    const ws = words([["grow", 0, 0.3], ["about", 0.3, 0.6], ["50%,", 0.6, 1.2], ["15%", 1.3, 1.9], ["over", 1.9, 2.1], ["the", 2.1, 2.2], ["next", 2.2, 2.5]]);
    const { edit, transcript } = setup(ws, [cut("k10", 0.6, 1.2, "stumble")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("Jobs to grow about 15% over the next 10 years."), envelopes: new Map([["c1", envOf([[0, 1.25], [1.25, 2.5]])]]), style });
    expect(out.cuts[0]).toMatchObject({ enabled: true, breathe: BREATHE_MS });
    expect(keptText(out, transcript)).toBe("grow about 15% over the next");
  });

  it("'buy, Open Code' — an aside cut mid-sentence lands between words and keeps a beat before the next one", () => {
    const ws = words([["check", 0, 0.3], ["before", 0.3, 0.5], ["you", 0.5, 0.7], ["buy,", 0.7, 1.0], ["but", 1.0, 1.15], ["This", 1.6, 1.7], ["is", 1.7, 1.9], ["agents.", 4.0, 4.5], ["So", 4.5, 4.7], ["Open", 5.0, 5.3], ["Code", 5.3, 5.6], ["just", 5.6, 5.8]]);
    const env = envOf([[0, 0.97], [1.0, 1.15], [1.6, 1.9], [4.0, 4.67], [5.0, 5.8]]);
    const { edit, transcript } = setup(ws, [cut("k73", 1.0, 4.7, "adlib")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("These prices are current, so check before you buy.", "OpenCode just made DeepSeek free."), envelopes: new Map([["c1", env]]), style });
    const k73 = out.cuts[0]!;
    expect(k73.start).toBeLessThanOrEqual(1.0); // snapped into the dip before "but", not inside it
    expect(k73).toMatchObject({ enabled: true, breathe: BREATHE_MS, join: { continuation: true, newSentence: true } });
    const tl = buildTimeline(out, transcript, [{ id: "c1", name: "c1", path: "/x", duration: 8, width: 1920, height: 1080, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false }], config);
    const after = tl.segments.find((s) => s.end > 5.3)!;
    expect(5.0 - after.start).toBeGreaterThanOrEqual(0.2); // a beat of quiet before "Open"
  });

  it("'Seek V V4.1' — a tiny stutter stays under Natural rather than splice inside a word run, and goes under Clean", () => {
    const ws = words([["Deep", 0, 0.2], ["Seek", 0.2, 0.5], ["V", 0.5, 0.58], ["V4.1", 0.6, 1.2], ["flash", 1.2, 1.5]]);
    const { edit, transcript } = setup(ws, [cut("k26", 0.5, 0.58, "stumble")]);
    const ctx = { transcript, script: scriptOf("OpenCode just made DeepSeek V4.1 Flash free."), envelopes: new Map([["c1", envOf([[0, 1.5]])]]) };
    expect(applyJoins(edit, { ...ctx, style }).cuts[0]!.enabled).toBe(false);
    expect(applyJoins(edit, { ...ctx, style: { ...style, disfluencies: "clean" } }).cuts[0]!.enabled).toBe(true);
  });
});

describe("join pass bookkeeping", () => {
  const ws = words([["Deep", 0, 0.2], ["Seek", 0.2, 0.5], ["V", 0.5, 0.58], ["V4.1", 0.6, 1.2], ["flash", 1.2, 1.5]]);
  const { edit, transcript } = setup(ws, [cut("k26", 0.5, 0.58, "stumble"), cut("u1", 1.2, 1.5, "user", { by: "user" })]);
  const ctx = { transcript, script: scriptOf("OpenCode just made DeepSeek V4.1 Flash free."), envelopes: new Map([["c1", envOf([[0, 1.5]])]]), style };

  it("is idempotent and reversible: a policy change can always be undone", () => {
    const once = applyJoins(edit, ctx);
    expect(applyJoins(once, ctx)).toBe(once);
    const light = applyJoins(once, { ...ctx, style: { ...style, disfluencies: "clean" } });
    expect(applyJoins(light, ctx).cuts).toEqual(once.cuts);
  });

  it("never touches the user's own cuts", () => {
    expect(applyJoins(edit, ctx).cuts.find((c) => c.id === "u1")).toEqual(edit.cuts[1]);
  });
});
