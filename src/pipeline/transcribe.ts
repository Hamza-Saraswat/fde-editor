// Transcribe stage (with the script alignment run inline) and the standalone Align stage.
import { projectPaths } from "../core/paths.ts";
import { CandidatesSchema, type Candidates, type Config, type Transcript } from "../core/schema.ts";
import { writeJson } from "../core/store.ts";
import { requireScript, requireTranscript } from "./load.ts";
import { plural, withDeps, type PipelineDeps, type StageFn } from "./types.ts";

export type TranscribeStageOptions = {
  engine?: Config["transcription"]["engine"];
  localEngine?: Config["transcription"]["localEngine"];
  localModel?: Config["transcription"]["localModel"];
  force?: boolean;
};

/** alignScript → candidates.json. */
export async function alignAndWrite(slug: string, transcript: Transcript, deps: Pick<PipelineDeps, "alignScript">): Promise<Candidates> {
  const script = await requireScript(slug);
  const candidates = deps.alignScript(script, transcript);
  return writeJson(projectPaths(slug).candidates, CandidatesSchema, candidates);
}

export function alignSummary(c: Candidates): string {
  const total = c.sentences.length;
  const matched = c.sentences.filter((s) => s.chosen !== null).length;
  const retakes = c.sentences.filter((s) => s.occurrences.length > 1).length;
  const parts = [`${matched}/${total} script sentences matched`, `${c.missing.length} missing`];
  if (retakes) parts.push(`${plural(retakes, "sentence")} with retakes`);
  if (c.adlibs.length) parts.push(plural(c.adlibs.length, "ad-lib"));
  return parts.join(" · ");
}

export const transcribeStage: StageFn<TranscribeStageOptions | undefined> = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const o = ctx.options ?? {};
  const transcript = await d.transcribeProject(slug, {
    engine: o.engine,
    localEngine: o.localEngine,
    localModel: o.localModel,
    force: o.force,
    signal: ctx.signal,
    onProgress: (msg, f) => ctx.progress(f * 0.95, msg),
  });
  ctx.signal.throwIfAborted();
  ctx.progress(0.96, "Aligning the transcript to the script");
  const candidates = await alignAndWrite(slug, transcript, d);
  return [
    plural(transcript.words.length, "word"),
    plural(transcript.fillers.length, "filler candidate"),
    alignSummary(candidates),
  ].join(" · ");
};

export const alignStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const transcript = await requireTranscript(slug);
  ctx.progress(0.1, "Aligning the transcript to the script");
  const candidates = await alignAndWrite(slug, transcript, d);
  return alignSummary(candidates);
};
