// X clips stage: Claude picks 2–3 moments of the final render, each gets burned-in captions (a
// transparent HyperFrames layer) and is cut to out/x-clips/clip-N.mp4.
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isFillerWord } from "../core/normalize.ts";
import { projectPaths } from "../core/paths.ts";
import { XClipPlanSchema, type Timeline, type Word } from "../core/schema.ts";
import { readJsonIfExists, writeJson } from "../core/store.ts";
import type { CaptionWord } from "../graphics/captions.ts";
import { loadEditInputs, renderInfoPath, RenderInfoSchema } from "./load.ts";
import { claudeEventLine } from "./plan.ts";
import { scriptSpellingMap } from "./spelling.ts";
import { plural, withDeps, type StageFn } from "./types.ts";

export type XClipsStageOptions = { count?: number };

/**
 * Every kept, non-filler word in final-render seconds (A-roll time + intro), with script spelling;
 * same placement rule as the SRT (a word belongs to the segment holding its midpoint).
 */
export function finalCaptionWords(words: Word[], timeline: Timeline, introSeconds: number, spelling?: Map<string, string>): CaptionWord[] {
  const locate = (w: Word) => {
    const mid = (w.start + w.end) / 2;
    for (const s of timeline.segments) {
      if (s.clipId !== w.clipId) continue;
      const len = s.frames / timeline.fps;
      if (mid < s.start || mid >= s.start + len) continue;
      const clamp = (t: number) => Math.min(len, Math.max(0, t - s.start));
      return { start: s.outStart + clamp(w.start), end: s.outStart + clamp(w.end) };
    }
    return null;
  };
  const placed = words
    .filter((w) => !isFillerWord(w.text))
    .map((w) => {
      const at = locate(w);
      if (!at) return null;
      const text = (spelling?.has(w.id) ? spelling.get(w.id)! : w.text).replace(/\s+/g, " ").trim();
      return { text, start: at.start + introSeconds, end: at.end + introSeconds };
    })
    .filter((w): w is CaptionWord => w !== null)
    .sort((a, b) => a.start - b.start);
  const out: CaptionWord[] = [];
  for (const w of placed) {
    const prev = out[out.length - 1];
    if (!w.text) {
      if (prev) prev.end = Math.max(prev.end, w.end); // second half of a script word spoken as two
      continue;
    }
    out.push({ ...w });
  }
  return out;
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** Words overlapping [start, end) of the final, shifted to clip time (ms precision) and clamped to the clip. */
export function clipCaptionWords(words: CaptionWord[], start: number, end: number): CaptionWord[] {
  const dur = end - start;
  return words
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ text: w.text, start: ms(Math.max(0, w.start - start)), end: ms(Math.min(dur, w.end - start)) }))
    .filter((w) => w.end > w.start);
}

export const xclipsStage: StageFn<XClipsStageOptions | undefined> = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const paths = projectPaths(slug);
  if (!existsSync(paths.final)) throw new Error("No final render yet — run Render first");
  const info = await readJsonIfExists(renderInfoPath(slug), RenderInfoSchema);
  if (!info) throw new Error("out/render.json is missing — run Render again");
  const { config, edit, transcript, script, timeline } = await loadEditInputs(slug, d);

  ctx.progress(undefined, "Claude is picking moments for X");
  const plan = await d.planXClips(slug, {
    count: ctx.options?.count,
    signal: ctx.signal,
    onEvent: (event) => {
      ctx.emit({ type: "claude", stage: "xclips", event });
      const line = claudeEventLine(event);
      if (line) ctx.progress(undefined, line);
    },
  });
  await writeJson(paths.xclips, XClipPlanSchema, plan);

  const spelling = script ? scriptSpellingMap(script, transcript, edit) : undefined;
  const words = finalCaptionWords(transcript.words, timeline, info.introSeconds, spelling);
  await mkdir(paths.xclipsDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });
  const n = plan.clips.length;
  for (const [i, clip] of plan.clips.entries()) {
    ctx.signal.throwIfAborted();
    const k = i + 1;
    const at = (f: number) => 0.1 + (0.9 * (i + f)) / n;
    const end = Math.min(clip.end, info.duration);
    if (end <= clip.start) throw new Error(`X clip ${k} (${clip.start}–${clip.end}s) is outside the final render`);
    const captionsMov = join(paths.cacheDir, `xclip-${k}-captions.mov`);
    ctx.progress(at(0), `Clip ${k}/${n}: rendering captions`);
    await d.renderCaptionLayer(clipCaptionWords(words, clip.start, end), end - clip.start, captionsMov, {
      width: 1920,
      height: 1080,
      fps: config.output.fps,
      signal: ctx.signal,
      workDir: join(paths.cacheDir, `xclip-${k}-captions`),
    });
    ctx.progress(at(0.5), `Clip ${k}/${n}: cutting`);
    await d.renderXClip(slug, paths.final, { start: clip.start, end }, captionsMov, join(paths.xclipsDir, `clip-${k}.mp4`), {
      signal: ctx.signal,
      onProgress: (f, msg) => ctx.progress(at(0.5 + f / 2), `Clip ${k}/${n}: ${msg}`),
    });
  }
  // clips left over from an earlier, longer pick
  for (const f of await readdir(paths.xclipsDir)) {
    const m = /^clip-(\d+)\.mp4$/.exec(f);
    if (m && Number(m[1]) > n) await rm(join(paths.xclipsDir, f), { force: true });
  }
  return `${plural(n, "X clip")} ready`;
};
