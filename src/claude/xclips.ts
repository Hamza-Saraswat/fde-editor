// Claude picks 2–3 strong 30–60 s moments from the final edit for X. Times are in FINAL video
// seconds (intro included), because the clips are cut from out/final.mp4.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PROMPTS_DIR, REPO_ROOT, projectPaths } from "../core/paths.ts";
import { EditSchema, TranscriptSchema, XClipPlanSchema, type XClipPlan } from "../core/schema.ts";
import { isFillerWord } from "../core/normalize.ts";
import { loadConfig, loadProject, readJsonIfExists } from "../core/store.ts";
import { buildTimeline, keptWordIds, sourceToOutput } from "../core/timeline.ts";
import { runClaude, type ClaudeEvent } from "./runner.ts";

export type FinalLine = { start: number; end: number; text: string };

/** The final video's speech as timed lines (break at sentence ends or pauses > 0.7 s). */
export async function finalTranscriptLines(slug: string): Promise<{ lines: FinalLine[]; duration: number; introSeconds: number; chapters: { title: string; start: number }[] }> {
  const paths = projectPaths(slug);
  const [project, config, edit, transcript] = await Promise.all([
    loadProject(slug), loadConfig(), readJsonIfExists(paths.edit, EditSchema), readJsonIfExists(paths.transcript, TranscriptSchema),
  ]);
  if (!edit || !transcript) throw new Error("No edit yet");
  const renderInfo = existsSync(join(paths.outDir, "render.json"))
    ? (JSON.parse(await readFile(join(paths.outDir, "render.json"), "utf8")) as { introSeconds?: number; duration?: number })
    : {};
  const intro = renderInfo.introSeconds ?? 0;
  const timeline = buildTimeline(edit, transcript, project.clips, config);
  const kept = keptWordIds(edit, transcript);
  const lines: FinalLine[] = [];
  let cur: { start: number; end: number; words: string[] } | null = null;
  for (const w of transcript.words) {
    if (!kept.has(w.id) || isFillerWord(w.text)) continue;
    const t = sourceToOutput(timeline, w.clipId, w.start);
    if (t === null) continue;
    const te = (sourceToOutput(timeline, w.clipId, w.end) ?? t + (w.end - w.start)) + intro;
    const ts = t + intro;
    if (cur && (ts - cur.end > 0.7 || cur.words.length >= 28)) {
      lines.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
      cur = null;
    }
    cur ??= { start: ts, end: te, words: [] };
    cur.words.push(w.text.trim());
    cur.end = te;
    if (/[.!?]$/.test(w.text.trim())) {
      lines.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
      cur = null;
    }
  }
  if (cur) lines.push({ start: cur.start, end: cur.end, text: cur.words.join(" ") });
  return {
    lines,
    duration: renderInfo.duration ?? timeline.duration + intro,
    introSeconds: intro,
    chapters: timeline.chapters.map((c) => ({ title: c.title, start: c.start + intro })),
  };
}

export async function planXClips(slug: string, opts: { count?: number; signal?: AbortSignal; onEvent?: (e: ClaudeEvent) => void } = {}): Promise<XClipPlan> {
  const paths = projectPaths(slug);
  const count = Math.min(3, Math.max(1, opts.count ?? 3));
  const { lines, duration, introSeconds, chapters } = await finalTranscriptLines(slug);
  const project = await loadProject(slug);
  const config = await loadConfig();
  await mkdir(paths.runsDir, { recursive: true });
  const inputFile = join(paths.runsDir, "xclips-input.txt");
  const fmt = (t: number) => t.toFixed(1);
  await writeFile(inputFile, [
    `VIDEO: ${project.title}`,
    `FINAL DURATION: ${fmt(duration)} s (intro ends at ${fmt(introSeconds)} s; the last ~12 s are the end card)`,
    `CLIPS WANTED: ${count}`,
    "CHAPTERS:",
    ...chapters.map((c) => `  ${fmt(c.start)} ${c.title}`),
    "TRANSCRIPT (final-video seconds):",
    ...lines.map((l) => `[${fmt(l.start)}-${fmt(l.end)}] ${l.text}`),
  ].join("\n") + "\n");

  const schema = z.toJSONSchema(XClipPlanSchema) as Record<string, unknown>;
  delete schema.$schema;
  const res = await runClaude({
    prompt: `Pick ${count} clips for X from the video in ${inputFile}. Read it, then return the JSON.`,
    appendSystemPromptFile: join(PROMPTS_DIR, "x-clips.md"),
    jsonSchema: schema,
    allowedTools: ["Read"],
    model: config.claude.model,
    maxTurns: 6,
    cwd: REPO_ROOT,
    addDirs: [paths.root],
    signal: opts.signal,
    logFile: join(paths.runsDir, `xclips-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
    onEvent: opts.onEvent,
  });
  const plan = XClipPlanSchema.parse(res.structured);
  // Clamp into the spoken part of the video and to a sane length.
  const lo = introSeconds, hi = Math.max(lo, duration - 12);
  plan.clips = plan.clips
    .map((c) => ({ ...c, start: Math.max(lo, Math.min(c.start, hi)), end: Math.max(lo, Math.min(c.end, hi)) }))
    .filter((c) => c.end - c.start >= 10)
    .slice(0, count);
  if (!plan.clips.length) throw new Error("Claude returned no usable clips");
  await writeFile(paths.xclips, JSON.stringify(plan, null, 2) + "\n");
  return plan;
}
