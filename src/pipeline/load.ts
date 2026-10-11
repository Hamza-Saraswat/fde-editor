// Reading what a stage needs from the project folder, with errors that tell the user which stage to run.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectPaths } from "../core/paths.ts";
import {
  EditSchema, ScriptDocSchema, TranscriptSchema,
  type Config, type Edit, type Project, type ScriptDoc, type Timeline, type Transcript,
} from "../core/schema.ts";
import { loadProject, readJson, readJsonIfExists } from "../core/store.ts";
import { buildTimeline } from "../core/timeline.ts";
import type { PipelineDeps } from "./types.ts";

export async function requireTranscript(slug: string): Promise<Transcript> {
  const file = projectPaths(slug).transcript;
  if (!existsSync(file)) throw new Error("No transcript yet — run Transcribe first");
  return readJson(file, TranscriptSchema);
}

export async function requireScript(slug: string): Promise<ScriptDoc> {
  const file = projectPaths(slug).script;
  if (!existsSync(file)) throw new Error("This project has no script.json");
  return readJson(file, ScriptDocSchema);
}

export async function requireEdit(slug: string): Promise<Edit> {
  const file = projectPaths(slug).edit;
  if (!existsSync(file)) throw new Error("No edit yet — run Plan edit first");
  return readJson(file, EditSchema);
}

export type EditInputs = {
  project: Project;
  config: Config;
  edit: Edit;
  transcript: Transcript;
  script: ScriptDoc | null;
  timeline: Timeline;
};

/** Everything the preview / render / X-clip stages need, with the timeline derived from the edit. */
export async function loadEditInputs(slug: string, deps: Pick<PipelineDeps, "loadConfig">): Promise<EditInputs> {
  const edit = await requireEdit(slug);
  const transcript = await requireTranscript(slug);
  const [project, config, script] = await Promise.all([
    loadProject(slug),
    deps.loadConfig(),
    readJsonIfExists(projectPaths(slug).script, ScriptDocSchema).catch(() => null),
  ]);
  const timeline = buildTimeline(edit, transcript, project.clips, config);
  return { project, config, edit, transcript, script, timeline };
}

// ---------- out/render.json: what the final render looked like (the X-clip stage needs the intro length) ----------

export const RenderInfoSchema = z.object({
  introSeconds: z.number(),
  arollSeconds: z.number(),
  outroSeconds: z.number(),
  duration: z.number(),
  renderedAt: z.string().optional(),
});
export type RenderInfo = z.infer<typeof RenderInfoSchema>;

export const renderInfoPath = (slug: string) => join(projectPaths(slug).outDir, "render.json");
