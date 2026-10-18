// Import stage: proxy + audio files for every clip, then hand off to Transcribe.
import { loadProject } from "../core/store.ts";
import { plural, withDeps, type StageFn } from "./types.ts";

export type ImportStageOptions = { then?: "transcribe" | "preview" } | undefined;

export const importStage: StageFn<ImportStageOptions> = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const project = await loadProject(slug);
  const clips = project.clips;
  if (!clips.length) return "No clips to import yet";
  const config = await d.loadConfig();
  let made = 0;
  for (const [i, clip] of clips.entries()) {
    ctx.signal.throwIfAborted();
    ctx.progress(i / clips.length, `Preparing ${clip.name}`);
    // picture fixes (mirror, stabilize) first: the proxy is made from the master
    const master = await d.ensureMaster(slug, clip, project.speakerSide, {
      signal: ctx.signal,
      config,
      onProgress: (f, msg) => ctx.progress((i + 0.7 * f) / clips.length, msg),
    });
    const res = await d.prepareClip(slug, clip, {
      signal: ctx.signal,
      config,
      onProgress: (f, msg) => ctx.progress((i + (master ? 0.7 + 0.3 * f : f)) / clips.length, msg),
    });
    made += res.made.length;
  }
  // a picture fix changes no words: go straight to the preview instead of re-transcribing
  if (ctx.options?.then === "preview") ctx.chain("preview");
  else ctx.chain("transcribe");
  return made
    ? `${plural(clips.length, "clip")} prepared (${plural(made, "file")} written)`
    : `${plural(clips.length, "clip")} already prepared`;
};
