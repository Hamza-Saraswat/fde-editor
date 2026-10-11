// Preview stage: edit → timeline → 720p preview.mp4 from the segment cache.
import { loadEditInputs } from "./load.ts";
import { fmtDuration, withDeps, type StageFn } from "./types.ts";

export const previewStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const { project, config, timeline } = await loadEditInputs(slug, d);
  const res = await d.buildPreview(slug, timeline, {
    signal: ctx.signal,
    config,
    clips: project.clips,
    onProgress: (f, msg) => ctx.progress(f, msg),
  });
  return `Preview ready: ${fmtDuration(res.duration)} (${res.encoded} segments encoded, ${res.reused} reused)`;
};
