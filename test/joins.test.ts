import { describe, expect, it } from "vitest";
import { applyJoins, BREATHE_MS, LEAD_IN_MS, skeleton } from "../src/core/joins.ts";
import { normalizeWords } from "../src/core/normalize.ts";
import { ConfigSchema, type Cut, type Edit, type ScriptDoc, type Transcript, type Word } from "../src/core/schema.ts";
import { resolveStyle } from "../src/core/style.ts";
import { buildTimeline, keptWordIds } from "../src/core/timeline.ts";
import type { Envelope } from "../src/media/energy.ts";
import { motionOf } from "../src/media/motion.ts";

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
const clipC1 = (duration: number) => ({ id: "c1", name: "c1", path: "/x", duration, width: 1920, height: 1080, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false });
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
    expect(k73).toMatchObject({ enabled: true, breathe: LEAD_IN_MS, join: { continuation: true, newSentence: true } });
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

// Hamza's notes on the full Video 1 v2 cut (Oct 19), rebuilt from the real word stamps.
describe("join pass on the Video 1 v2 notes", () => {
  const clean = { ...style, disfluencies: "clean" as const };

  it("1:38 — a cut from a finished sentence keeps the last try at the next sentence's opening", () => {
    const ws = words([["hasn't.", 104.26, 104.75], ["The", 105.69, 105.93], ["issue", 105.98, 106.41], ["when", 106.45, 106.61], ["stools", 106.77, 107.17], ["the", 107.53, 107.69], ["issue", 107.69, 107.93], ["is", 107.93, 108.09], ["was", 108.17, 108.33], ["when", 108.33, 108.49], ["the", 108.49, 108.57], ["tools", 108.57, 108.97], ["started", 108.97, 109.21], ["to", 109.21, 109.29], ["write", 109.29, 109.61], ["the", 109.61, 109.77], ["code.", 109.77, 109.9]]);
    const { edit, transcript } = setup(ws, [cut("k24", 105.64, 108.53, "adlib")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("Then the tools started writing the code."), envelopes: new Map([["c1", envOf(voicedAll(ws), 112)]]), style });
    expect(keptText(out, transcript)).toBe("hasn't. the issue is was when the tools started to write the code.");
  });

  it("1:47 — a word said on both sides of the cut goes with it ('task and | And just go')", () => {
    const ws = words([["whole", 117.05, 117.29], ["task", 117.29, 117.61], ["and", 117.61, 117.77], ["just", 117.77, 117.93], ["go", 117.93, 118.09], ["without", 118.09, 118.41], ["it", 118.41, 118.57], ["And", 119.28, 119.6], ["just", 119.6, 119.76], ["go", 119.76, 119.92], ["without", 119.92, 120.16], ["babysitting,", 120.3, 120.9]]);
    const { edit, transcript } = setup(ws, [cut("k3", 117.78, 118.69, "false-start")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("Coding agents that can take a whole task and just go do it without much babysitting."), envelopes: new Map([["c1", envOf(voicedAll(ws), 122)]]), style });
    expect(keptText(out, transcript)).toBe("whole task And just go without babysitting,");
  });

  it("2:09 — under Natural a small repeat next to running speech stays ('measure new — new code')", () => {
    const ws = words([["they", 140.32, 140.48], ["measure", 140.48, 140.88], ["new", 140.88, 141.018], ["new", 141.546, 141.68], ["code", 141.68, 141.92], ["bases,", 141.92, 142.4]]);
    const { edit, transcript } = setup(ws, [cut("k4", 140.88, 141.018, "repeat")]);
    const ctx = { transcript, script: scriptOf("They measure new code, not whole codebases."), envelopes: new Map([["c1", envOf(voicedAll(ws), 144)]]) };
    expect(applyJoins(edit, { ...ctx, style }).cuts[0]!.enabled).toBe(false);
    expect(applyJoins(edit, { ...ctx, style: clean }).cuts[0]!.enabled).toBe(true);
  });

  it("8:50 — a repeat cut that starts in a pause stays cut ('skip. | the posting asks')", () => {
    const ws = words([["most", 234.12, 234.44], ["people", 234.44, 234.76], ["skip.", 234.76, 235.4], ["The", 235.4, 235.56], ["posting", 235.56, 235.96], ["the", 236.2, 236.36], ["posting", 236.36, 236.84], ["asks", 236.84, 237.16], ["for", 237.16, 237.4]]);
    const env = envOf([[234.12, 235.25], [235.4, 237.4]], 240); // "skip." trails off well before the restart
    const { edit, transcript } = setup(ws, [cut("k14", 235.4, 235.96, "repeat")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("The posting asks for cross-functional collaboration."), envelopes: new Map([["c1", env]]), style });
    expect(out.cuts[0]!.enabled).toBe(true);
    expect(keptText(out, transcript)).toBe("most people skip. the posting asks for");
  });

  it("12:21 — under Natural a short filler phrase that runs into the next word stays ('uh, you know, basically')", () => {
    const ws = words([["agents", 467.93, 468.41], ["and", 468.41, 468.57], ["workflows,", 468.57, 469.076], ["uh,", 469.29, 469.45], ["you", 469.45, 469.53], ["know,", 469.53, 469.77], ["basically", 469.77, 470.17], ["a", 470.17, 470.25], ["plain", 470.25, 470.57]]);
    const { edit, transcript } = setup(ws, [cut("k18", 469.29, 469.77, "filler")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("The cheat sheet on agents and workflows, a plain-English breakdown of RAG."), envelopes: new Map([["c1", envOf(voicedAll(ws), 472)]]), style });
    expect(out.cuts[0]!.enabled).toBe(false);
  });

  it("3:04 — of two cuts 0.6 s apart, the small stutter gives way: one cut, no sliver", () => {
    const ws = words([["are", 203.55, 203.79], ["mostly", 203.79, 204.11], ["come", 204.11, 204.27], ["coming", 204.43, 204.67], ["from", 204.67, 204.91], ["software", 204.91, 205.31], ["engineering", 205.31, 205.79], ["data,", 205.87, 206.19], ["uh", 206.23, 206.4], ["software", 206.43, 206.91], ["engineering,", 206.91, 207.42], ["data", 207.5, 207.8], ["science,", 207.8, 208.3]]);
    const { edit, transcript } = setup(ws, [cut("k6", 204.0, 204.38, "stumble"), cut("k7", 204.94, 206.44, "false-start")]);
    for (const st of [style, clean]) {
      const out = applyJoins(edit, { transcript, script: scriptOf("People moving into it are mostly coming from software engineering, data science, and full-stack work."), envelopes: new Map([["c1", envOf(voicedAll(ws), 210)]]), style: st });
      expect(out.cuts.find((c) => c.id === "k6")!.enabled).toBe(false);
      expect(out.cuts.find((c) => c.id === "k7")!.enabled).toBe(true);
      expect(keptText(out, transcript)).toBe("are mostly come coming from software engineering, data science,");
    }
  });

  it("11:40 — a listen-back filler cut 2.5 s after an aside gives way instead of leaving a 2 s sliver", () => {
    const ws = words([["check", 416.72, 417.04], ["before", 417.04, 417.28], ["you", 417.28, 417.44], ["buy,", 417.44, 417.76], ["but", 417.76, 417.885], ["This", 418.33, 418.41], ["is", 418.41, 418.57], ["on", 421.69, 422.01], ["coding", 422.97, 423.37], ["agents.", 423.37, 423.93], ["So", 423.93, 424.09], ["Open", 424.426, 424.65], ["Code", 424.65, 424.97], ["just", 424.97, 425.13], ["made", 425.13, 425.37], ["Deep", 425.37, 425.69], ["Seek", 425.69, 426.01], ["V", 426.17, 426.25], ["V4.1", 426.81, 427.77], ["flash", 427.85, 428.17]]);
    const env = envOf([...voicedAll(ws), [426.6, 426.8]], 430); // the "uh" the listen-back heard
    const { edit, transcript } = setup(ws, [cut("k33", 417.76, 424.09, "adlib"), cut("ks", 426.607, 427.017, "filler", { by: "auto", wanted: true })]);
    const out = applyJoins(edit, { transcript, script: scriptOf("These prices are current, so check before you buy.", "OpenCode just made DeepSeek V4.1 Flash free."), envelopes: new Map([["c1", env]]), style: clean });
    expect(out.cuts.find((c) => c.id === "k33")!.enabled).toBe(true);
    expect(out.cuts.find((c) => c.id === "ks")!.enabled).toBe(false);
  });

  it("two asides with only an unscripted word between them merge into one cut", () => {
    const ws = words([["We", 0, 0.2], ["built", 0.2, 0.5], ["kind", 0.6, 0.8], ["of", 0.8, 0.9], ["like", 1.5, 1.7], ["you", 1.7, 1.8], ["know", 1.8, 2.0], ["the", 2.5, 2.6], ["tool.", 2.6, 3.0]]);
    const { edit, transcript } = setup(ws, [cut("a1", 0.6, 0.9, "adlib"), cut("a2", 1.7, 2.0, "adlib")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("We built the tool."), envelopes: new Map([["c1", envOf(voicedAll(ws))]]), style: clean });
    expect(out.cuts.filter((c) => c.enabled)).toHaveLength(1);
    expect(keptText(out, transcript)).toBe("We built the tool.");
  });

  it("8:31 — under Natural a short aside that runs straight into the next word stays (no clipped '-ver evals')", () => {
    const ws = words([["linked", 214.87, 215.27], ["below", 215.27, 215.52], ["to", 215.67, 215.83], ["my", 215.86, 215.99], ["sub", 215.99, 216.07], ["stack.", 216.23, 216.64], ["You", 217.04, 217.11], ["can", 217.11, 217.19], ["go", 217.19, 217.27], ["over", 217.27, 217.43], ["evals", 217.43, 217.99], ["and", 218.07, 218.15], ["guardrails", 218.15, 218.55]]);
    const { edit, transcript } = setup(ws, [cut("k30", 217.01, 217.44, "adlib")]);
    const ctx = { transcript, script: scriptOf("Workflows versus agents, I wrote a cheat sheet on that, it's linked below.", "Evals and guardrails, so you can prove it works."), envelopes: new Map([["c1", envOf(voicedAll(ws), 220)]]) };
    expect(applyJoins(edit, { ...ctx, style }).cuts[0]!.enabled).toBe(false);
    expect(applyJoins(edit, { ...ctx, style: clean }).cuts[0]!.enabled).toBe(true);
  });

  it("10:18 — a false start cut out of running speech keeps the restart's own pause before 'And'", () => {
    const ws = words([["pick", 332.29, 332.47], ["something", 332.47, 332.71], ["else", 332.71, 333.03], ["and", 333.03, 333.19], ["don't", 333.19, 333.51], ["rant", 333.51, 333.67], ["romantif", 333.83, 334.31], ["And", 334.67, 334.83], ["don't", 334.83, 335.15], ["romanticize", 335.15, 335.95]]);
    const { edit, transcript } = setup(ws, [cut("k15", 333.06, 334.44, "false-start")]);
    const out = applyJoins(edit, { transcript, script: scriptOf("If nobody would use it, pick something else and don't romanticize the first idea."), envelopes: new Map([["c1", envOf(voicedAll(ws), 337)]]), style });
    const k15 = out.cuts[0]!;
    expect(k15).toMatchObject({ enabled: true, breathe: LEAD_IN_MS });
    const tl = buildTimeline(out, transcript, [clipC1(337)], config);
    const restart = tl.segments.find((s) => s.end > 334.8)!;
    expect(334.67 - restart.start).toBeGreaterThanOrEqual(0.3);
  });
});

describe("camera handling", () => {
  /** 30 fps motion: 0.5 everywhere, `level` over the given spans. */
  const motion = (dur: number, spans: [number, number, number][]) => {
    const v = new Array(Math.round(dur * 30)).fill(0.5);
    for (const [a, b, level] of spans) for (let i = Math.round(a * 30); i < Math.round(b * 30); i++) v[i] = level;
    return motionOf(v, 30);
  };
  // 8:10 of Video 1 v2: "before you ship … it." then a reach to the phone and a pause/resume, then "For type two"
  const ws = words([["before", 0.1, 0.4], ["you", 0.4, 0.5], ["ship", 0.5, 0.93], ["it.", 1.81, 1.91], ["For", 3.14, 3.46], ["type", 3.49, 3.86], ["two,", 3.86, 4.26], ["go", 4.3, 4.5], ["back.", 4.5, 4.9]]);
  const script = scriptOf("Before you ship it.", "For type two, go back.");
  const envelopes = new Map([["c1", envOf(voicedAll(ws), 6)]]);

  it("8:10 — a reach in a pause is cut, with the word said during it", () => {
    const { edit, transcript } = setup(ws, []);
    const out = applyJoins(edit, { transcript, script, envelopes, style, motion: new Map([["c1", motion(6, [[1.85, 2.48, 5], [3.04, 3.08, 30]])]]), clips: [clipC1(9)] });
    const h = out.cuts.find((c) => c.reason === "handling")!;
    expect(h).toMatchObject({ enabled: true, by: "auto" });
    expect(h.end).toBeGreaterThanOrEqual(3.067); // past the pause/resume frame
    expect(keptText(out, transcript)).toBe("before you ship For type two, go back.");
    expect(applyJoins(out, { transcript, script, envelopes, style, motion: new Map([["c1", motion(6, [[1.85, 2.48, 5], [3.04, 3.08, 30]])]]), clips: [clipC1(9)] })).toBe(out);
  });

  it("a big gesture while talking is not a reach", () => {
    const { edit, transcript } = setup(ws, []);
    const out = applyJoins(edit, { transcript, script, envelopes, style, motion: new Map([["c1", motion(6, [[3.2, 4.4, 5]])]]), clips: [clipC1(9)] });
    expect(out.cuts.filter((c) => c.reason === "handling")).toHaveLength(0);
  });

  it("a take stopped right after its last word holds the picture from that word (the reach to stop it)", () => {
    const { edit, transcript } = setup(ws, []);
    const out = applyJoins(edit, { transcript, script, envelopes, style, motion: new Map([["c1", motion(5.4, [])]]), clips: [clipC1(5.4)] });
    expect(out.holds).toEqual([{ clipId: "c1", start: 4.7, end: 5.4 }]);
    const later = applyJoins(edit, { transcript, script, envelopes, style, motion: new Map([["c1", motion(9, [])]]), clips: [clipC1(9)] });
    expect(later.holds).toBeUndefined();
  });

  it("a user's decision about a handling cut stands", () => {
    const { edit, transcript } = setup(ws, []);
    const ctx = { transcript, script, envelopes, style, motion: new Map([["c1", motion(6, [[1.85, 2.48, 5], [3.04, 3.08, 30]])]]), clips: [clipC1(9)] };
    const out = applyJoins(edit, ctx);
    const restored = { ...out, cuts: out.cuts.map((c) => (c.reason === "handling" ? { ...c, enabled: false, pinned: true } : c)) };
    const again = applyJoins(restored, ctx);
    expect(again.cuts.filter((c) => c.reason === "handling")).toEqual(restored.cuts.filter((c) => c.reason === "handling"));
  });
});
