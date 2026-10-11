// Import stage: proxy + audio files for every clip, then hand off to Transcribe.
import { loadProject } from "../core/store.ts";
import { plural, withDeps, type StageFn } from "./types.ts";

export const importStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const project = await loadProject(slug);
  const clips = project.clips;
  if (!clips.length) return "No clips to import yet";
  const config = await d.loadConfig();
  let made = 0;
  for (const [i, clip] of clips.entries()) {
    ctx.signal.throwIfAborted();
    ctx.progress(i / clips.length, `Preparing ${clip.name}`);
    const res = await d.prepareClip(slug, clip, {
      signal: ctx.signal,
      config,
      onProgress: (f, msg) => ctx.progress((i + f) / clips.length, msg),
    });
    made += res.made.length;
  }
  ctx.chain("transcribe");
  return made
    ? `${plural(clips.length, "clip")} prepared (${plural(made, "file")} written)`
    : `${plural(clips.length, "clip")} already prepared`;
};
