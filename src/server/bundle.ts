// GET /api/projects/:slug: everything the UI needs for one project in one response.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { projectPaths } from "../core/paths.ts";
import {
  CandidatesSchema, EditSchema, ScriptDocSchema, TranscriptSchema, XClipPlanSchema,
  type Project, type Timeline,
} from "../core/schema.ts";
import { loadProject, readJsonIfExists } from "../core/store.ts";
import { buildTimeline } from "../core/timeline.ts";
import type { PipelineDeps } from "../pipeline/types.ts";
import type { GraphicStatus, Outputs, ProjectBundle } from "./api.ts";
import type { JobManager } from "./jobs.ts";

/** /media/<slug>/<path inside the project folder>, each segment URL-encoded. */
export function mediaUrl(slug: string, file: string): string {
  const rel = relative(projectPaths(slug).root, file).split(sep).map(encodeURIComponent).join("/");
  return `/media/${encodeURIComponent(slug)}/${rel}`;
}

/** Media URL with a ?v=<mtime> cache-buster, or undefined when the file does not exist. */
export function mediaUrlIfExists(slug: string, file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return `${mediaUrl(slug, file)}?v=${Math.round(statSync(file).mtimeMs)}`;
}

async function readOrNull<T>(what: string, read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[bundle] ${what} is unreadable:`, err instanceof Error ? err.message.split("\n")[0] : err);
    return null;
  }
}

export async function readOutputs(slug: string): Promise<Outputs> {
  const p = projectPaths(slug);
  const outputs: Outputs = { xclips: [] };
  const preview = mediaUrlIfExists(slug, p.preview);
  if (preview) {
    outputs.preview = preview;
    try {
      const info = JSON.parse(await readFile(join(p.outDir, "preview.json"), "utf8")) as { editVersion?: number };
      if (typeof info.editVersion === "number") outputs.previewEditVersion = info.editVersion;
    } catch {
      /* built before preview.json existed */
    }
  }
  const final = mediaUrlIfExists(slug, p.final);
  if (final) outputs.final = final;
  if (existsSync(p.chapters)) outputs.chapters = (await readFile(p.chapters, "utf8")).trim();
  const srt = mediaUrlIfExists(slug, p.srt);
  if (srt) outputs.srt = srt;
  const plan = await readOrNull("xclips.json", () => readJsonIfExists(p.xclips, XClipPlanSchema));
  plan?.clips.forEach((c, i) => {
    const url = mediaUrlIfExists(slug, join(p.xclipsDir, `clip-${i + 1}.mp4`));
    if (url) outputs.xclips.push({ url, hook: c.hook, start: c.start, end: c.end });
  });
  return outputs;
}

/** A stage left "running" on disk by a server that stopped, with no job behind it, shows as interrupted. */
function withLiveStages(project: Project, jobs: JobManager): Project {
  const stages = { ...project.stages };
  for (const [stage, status] of Object.entries(stages) as [keyof typeof stages, NonNullable<(typeof stages)[keyof typeof stages]>][]) {
    if (status.state === "running" && !jobs.runningJob(project.slug, stage)) {
      stages[stage] = { ...status, state: "error", message: "Interrupted (the server stopped) — run it again" };
    }
  }
  return { ...project, stages };
}

export async function buildBundle(slug: string, jobs: JobManager, deps: Pick<PipelineDeps, "loadConfig" | "graphicStatuses">): Promise<ProjectBundle> {
  const p = projectPaths(slug);
  const project = await loadProject(slug);
  const [script, transcript, candidates, edit] = await Promise.all([
    readOrNull("script.json", () => readJsonIfExists(p.script, ScriptDocSchema)),
    readOrNull("transcript.json", () => readJsonIfExists(p.transcript, TranscriptSchema)),
    readOrNull("candidates.json", () => readJsonIfExists(p.candidates, CandidatesSchema)),
    readOrNull("edit.json", () => readJsonIfExists(p.edit, EditSchema)),
  ]);
  let timeline: Timeline | null = null;
  if (edit && transcript) {
    try {
      timeline = buildTimeline(edit, transcript, project.clips, await deps.loadConfig());
    } catch (err) {
      console.error(`[bundle] timeline for ${slug} failed:`, err);
    }
  }
  let graphics: Record<string, GraphicStatus> = {};
  try {
    graphics = await deps.graphicStatuses(slug);
  } catch (err) {
    console.error(`[bundle] graphic statuses for ${slug} failed:`, err);
  }
  return {
    project: withLiveStages(project, jobs),
    script,
    transcript,
    candidates,
    edit,
    timeline,
    graphics,
    outputs: await readOutputs(slug),
    jobs: jobs.list(slug),
  };
}
