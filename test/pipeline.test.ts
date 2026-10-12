import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeEvent } from "../src/claude/runner.ts";
import { projectPaths } from "../src/core/paths.ts";
import { ConfigSchema, type Edit, type Overlay } from "../src/core/schema.ts";
import { graphicsStage, graphicsTargets } from "../src/pipeline/graphics.ts";
import { planStage } from "../src/pipeline/plan.ts";
import { renderStage } from "../src/pipeline/render.ts";
import { transcribeStage } from "../src/pipeline/transcribe.ts";
import { clipCaptionWords, finalCaptionWords, xclipsStage } from "../src/pipeline/xclips.ts";
import type { PipelineDeps, StageContext } from "../src/pipeline/types.ts";
import type { GraphicStatus, ServerEvent } from "../src/server/api.ts";
import type { StageName } from "../src/core/schema.ts";

const ROOT = mkdtempSync(join(tmpdir(), "fde-pipeline-"));
const prevProjectsDir = process.env.FDE_PROJECTS_DIR;
process.env.FDE_PROJECTS_DIR = join(ROOT, "projects");
afterAll(() => {
  if (prevProjectsDir === undefined) delete process.env.FDE_PROJECTS_DIR;
  else process.env.FDE_PROJECTS_DIR = prevProjectsDir;
  rmSync(ROOT, { recursive: true, force: true });
});

const SLUG = "demo";
const config = ConfigSchema.parse({});
const loadConfig = async () => config;

const TEXTS = ["Hello", "world.", "This", "is", "a", "test.", "Goodbye", "now."];
const WORDS = TEXTS.map((text, i) => ({ id: `w${i}`, clipId: "c1", text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 }));

const overlay = (cueId: string, a: number, b: number, enabled = true): Overlay => ({
  id: `o-${cueId}`, cueId, enabled, anchorWordId: `w${a}`, endWordId: `w${b}`, offsetMs: 0, layout: "side", brief: cueId, assetIds: [],
});

const baseEdit = (): Edit => ({
  version: 1,
  clipOrder: ["c1"],
  cuts: [],
  takeGroups: [
    { id: "tg1", sentenceIds: ["s0.1"], options: [{ startWordId: "w0", endWordId: "w1", clipId: "c1", start: 1, end: 1.9 }], chosen: 0, why: "" },
  ],
  overlays: [overlay("g1", 0, 2), overlay("g2", 3, 5), overlay("g3", 6, 7), overlay("g4", 6, 7, false)],
  chapters: [],
  intro: false,
  outro: false,
});

async function writeProject(edit: Edit | null = baseEdit()) {
  const p = projectPaths(SLUG);
  rmSync(p.root, { recursive: true, force: true });
  await mkdir(p.root, { recursive: true });
  const files: Record<string, unknown> = {
    "project.json": {
      slug: SLUG, title: "Demo", createdAt: "2026-10-11T00:00:00Z", scriptSource: "/x/demo.md",
      clips: [{ id: "c1", name: "take1.mov", path: "/x/take1.mov", duration: 6, width: 320, height: 180, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false }],
    },
    "script.json": {
      title: "Demo",
      sections: [{ id: "sec0", title: "Intro", level: 2, sentenceIds: ["s0.1"] }],
      sentences: [{ id: "s0.1", sectionId: "sec0", blockId: "b0.1", text: "Hello, World!", tokens: ["hello", "world"] }],
      cues: [],
    },
    "transcript.json": { engine: "test", model: "test", words: WORDS, silences: [], fillers: [] },
  };
  if (edit) files["edit.json"] = edit;
  for (const [f, v] of Object.entries(files)) await writeFile(join(p.root, f), JSON.stringify(v));
}

function fakeCtx<O>(options?: O) {
  const events: ServerEvent[] = [];
  const chained: { stage: StageName; options?: unknown }[] = [];
  const progress: [number | undefined, string][] = [];
  const controller = new AbortController();
  const ctx: StageContext<O> = {
    signal: controller.signal,
    emit: (e) => events.push(e),
    progress: (f, m) => progress.push([f, m]),
    options: options as O,
    chain: (stage, opts) => chained.push({ stage, options: opts }),
  };
  return { ctx, events, chained, progress, controller };
}

const ready = (cueId: string, over: Partial<GraphicStatus> = {}): GraphicStatus => ({
  cueId, state: "ready", message: "", hasMov: true, stale: false, ...over,
});

beforeEach(() => writeProject());

describe("render stage", () => {
  it("refuses when an enabled graphic has no .mov, without rendering", async () => {
    const renderFinal = vi.fn();
    const deps: Partial<PipelineDeps> = {
      loadConfig,
      graphicStatuses: async () => ({ g1: ready("g1"), g3: ready("g3", { hasMov: false, state: "error" }) }),
      renderFinal: renderFinal as unknown as PipelineDeps["renderFinal"],
    };
    await expect(renderStage(SLUG, fakeCtx().ctx, deps)).rejects.toThrow("Graphics missing for: g2, g3 — run Graphics first");
    expect(renderFinal).not.toHaveBeenCalled();
  });

  it("renders with every enabled graphic and writes chapters, captions and render.json", async () => {
    const calls: Parameters<PipelineDeps["renderFinal"]>[] = [];
    const deps: Partial<PipelineDeps> = {
      loadConfig,
      graphicStatuses: async () => ({ g1: ready("g1"), g2: ready("g2"), g3: ready("g3", { stale: true }) }),
      renderFinal: (async (...args: Parameters<PipelineDeps["renderFinal"]>) => {
        calls.push(args);
        return { path: "", frames: 0, duration: 12, introSeconds: 2, arollSeconds: 10, outroSeconds: 0, loudness: {} as never, encoded: 0, reused: 0, ms: 0 };
      }) as PipelineDeps["renderFinal"],
    };
    const { ctx, events } = fakeCtx();
    const msg = await renderStage(SLUG, ctx, deps);
    expect(msg).toMatch(/Final ready: 0:12 · 3 graphics/);
    const opts = calls[0]![2];
    expect(opts.overlays.map((o) => o.cueId)).toEqual(["g1", "g2", "g3"]);
    expect(opts.overlays[0]!.file).toBe(projectPaths(SLUG).graphicMov("g1"));
    expect(opts.intro).toBeUndefined();
    expect(events.some((e) => e.type === "log" && /out-of-date graphics: g3/.test(e.line))).toBe(true);
    const p = projectPaths(SLUG);
    const srt = await readFile(p.srt, "utf8");
    expect(srt).toContain("Hello, World!"); // script spelling; shifted by the 2 s intro
    expect(srt.split("\n")[1]).toMatch(/^00:00:02,/);
    expect(JSON.parse(await readFile(join(p.outDir, "render.json"), "utf8"))).toMatchObject({ introSeconds: 2, duration: 12 });
    expect(existsSync(p.chapters)).toBe(true);
  });
});

describe("graphics stage", () => {
  it("picks enabled overlays whose graphic is missing, unfinished or stale", () => {
    const targets = graphicsTargets(baseEdit().overlays, {
      g1: ready("g1"), g2: ready("g2", { stale: true }), g4: ready("g4", { hasMov: false, state: "error" }),
    });
    expect(targets).toEqual(["g2", "g3"]);
  });

  it("continues past a failing cue and reports it", async () => {
    const seen: string[] = [];
    const deps: Partial<PipelineDeps> = {
      graphicStatuses: async () => ({}),
      buildGraphic: async (_slug, cueId, opts) => {
        seen.push(cueId);
        opts?.onEvent?.({ kind: "text", text: `working on ${cueId}` });
        opts?.onProgress?.(0.5, "rendering");
        if (cueId === "g2") throw new Error("hyperframes lint failed");
        return ready(cueId);
      },
    };
    const { ctx, events } = fakeCtx<{ note?: string }>({ note: "bigger text" });
    const msg = await graphicsStage(SLUG, ctx, deps);
    expect(seen).toEqual(["g1", "g2", "g3"]);
    expect(msg).toBe("2/3 graphics built · failed: g2 (hyperframes lint failed)");
    const claude = events.filter((e) => e.type === "claude");
    expect(claude).toHaveLength(3);
    expect(claude[1]).toMatchObject({ stage: "graphics", cueId: "g2" });
    const finalStatus = (cueId: string) => events.filter((e) => e.type === "graphic" && e.status.cueId === cueId).at(-1);
    expect(finalStatus("g2")).toMatchObject({ status: { state: "error", message: "hyperframes lint failed" } });
    expect(finalStatus("g3")).toMatchObject({ status: { state: "ready" } });
  });

  it("throws when every cue fails, and builds only the requested cues", async () => {
    const deps: Partial<PipelineDeps> = {
      graphicStatuses: async () => ({}),
      buildGraphic: async () => {
        throw new Error("boom");
      },
    };
    await expect(graphicsStage(SLUG, fakeCtx({ cueIds: ["g3"] }).ctx, deps)).rejects.toThrow("All 1 graphic failed: g3 (boom)");
  });
});

describe("plan stage", () => {
  it("needs candidates first", async () => {
    await expect(planStage(SLUG, fakeCtx().ctx, { planEdit: vi.fn() })).rejects.toThrow(/run Transcribe first/);
  });

  it("forwards Claude events and chains a preview", async () => {
    await writeFile(projectPaths(SLUG).candidates, JSON.stringify({ sentences: [], adlibs: [], missing: [] }));
    const claudeEvents: ClaudeEvent[] = [
      { kind: "init", model: "opus", sessionId: "s1" },
      { kind: "tool", name: "Read", input: "plan-input.json" },
      { kind: "result", ok: true, text: "", costUsd: 0.42 },
    ];
    const deps: Partial<PipelineDeps> = {
      planEdit: async (_slug, opts) => {
        for (const e of claudeEvents) opts?.onEvent?.(e);
        return { plan: {} as never, edit: baseEdit(), warnings: ["take 3: unknown word id w99; skipped"], costUsd: 0.42 };
      },
    };
    const { ctx, events, chained, progress } = fakeCtx();
    const msg = await planStage(SLUG, ctx, deps);
    expect(events.filter((e) => e.type === "claude")).toEqual(claudeEvents.map((event) => ({ type: "claude", stage: "plan", event })));
    expect(events).toContainEqual({ type: "log", stage: "plan", line: "warning: take 3: unknown word id w99; skipped" });
    expect(chained).toEqual([{ stage: "preview", options: { sweep: true } }]);
    expect(msg).toBe("Edit planned: 1 take group · 0 cuts · 3 graphics · 1 warning · $0.42");
    expect(progress.some(([, m]) => m === "Claude: Read plan-input.json")).toBe(true);
  });
});

describe("transcribe stage", () => {
  it("transcribes, aligns inline and summarises", async () => {
    const deps: Partial<PipelineDeps> = {
      transcribeProject: async (_slug, opts) => {
        opts?.onProgress?.("c1: transcribing", 0.5);
        return { engine: "test", model: "test", words: WORDS, silences: [], fillers: [] };
      },
    };
    const { ctx, progress } = fakeCtx<undefined>();
    const msg = await transcribeStage(SLUG, ctx, deps);
    expect(msg).toBe("8 words · 0 filler candidates · 1/1 script sentences matched · 0 missing · 1 ad-lib");
    expect(progress[0]).toEqual([0.475, "c1: transcribing"]);
    expect(existsSync(projectPaths(SLUG).candidates)).toBe(true);
  });
});

describe("X clips", () => {
  it("maps kept words to final time, then to clip time", () => {
    // keeps 2.0–4.5 s of c1: "This" … "Goodbye" ("now." has its midpoint past the cut)
    const timeline = { fps: 30, segments: [{ clipId: "c1", start: 2, end: 4.5, frames: 75, outStart: 0 }], duration: 2.5, overlays: [], chapters: [] };
    const spelling = new Map([["w3", "IS"], ["w4", ""]]);
    const final = finalCaptionWords(WORDS, timeline, 5, spelling);
    expect(final.map((w) => w.text)).toEqual(["This", "IS", "test.", "Goodbye"]);
    expect(final[1]).toEqual({ text: "IS", start: 5.5, end: 6.4 }); // stretched over the merged "a"
    expect(clipCaptionWords(final, 6, 7)).toEqual([
      { text: "IS", start: 0, end: 0.4 },
      { text: "test.", start: 0.5, end: 0.9 },
    ]);
  });

  it("plans, renders captions and cuts each clip", async () => {
    const p = projectPaths(SLUG);
    await mkdir(p.outDir, { recursive: true });
    await writeFile(p.final, "");
    await writeFile(join(p.outDir, "render.json"), JSON.stringify({ introSeconds: 0, arollSeconds: 6, outroSeconds: 0, duration: 6 }));
    const captions: { words: unknown[]; dur: number; out: string }[] = [];
    const cuts: { start: number; end: number; out: string }[] = [];
    const deps: Partial<PipelineDeps> = {
      loadConfig,
      planXClips: async () => ({ clips: [{ start: 0.5, end: 2, hook: "Hello world", why: "opener" }] }),
      renderCaptionLayer: async (words, dur, out) => {
        captions.push({ words, dur, out });
        return out;
      },
      renderXClip: async (_slug, _final, clip, _cap, out) => {
        cuts.push({ ...clip, out });
        return { path: out, frames: 45, duration: 1.5 };
      },
    };
    const msg = await xclipsStage(SLUG, fakeCtx({ count: 1 }).ctx, deps);
    expect(msg).toBe("1 X clip ready");
    expect(cuts).toEqual([{ start: 0.5, end: 2, out: join(p.xclipsDir, "clip-1.mp4") }]);
    expect(captions[0]!.dur).toBe(1.5);
    expect(captions[0]!.out).toBe(join(p.cacheDir, "xclip-1-captions.mov"));
    expect(JSON.parse(await readFile(p.xclips, "utf8")).clips[0].hook).toBe("Hello world");
  });
});
