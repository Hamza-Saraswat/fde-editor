// Preview stage: edit → timeline → 720p preview.mp4 from the segment cache.
// Also writes out/preview.json with the edit version it was built from, so the UI can tell
// (from data, not event order) whether the preview matches the current cut.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths } from "../core/paths.ts";
import { loadEditInputs } from "./load.ts";
import { fmtDuration, withDeps, type StageFn } from "./types.ts";

export const previewStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const { project, config, timeline, edit } = await loadEditInputs(slug, d);
  const res = await d.buildPreview(slug, timeline, {
    signal: ctx.signal,
    config,
    clips: project.clips,
    onProgress: (f, msg) => ctx.progress(f, msg),
  });
  await writeFile(join(projectPaths(slug).outDir, "preview.json"), JSON.stringify({ editVersion: edit.version, duration: res.duration, builtAt: new Date().toISOString() }) + "\n");
  return `Preview ready: ${fmtDuration(res.duration)} (${res.encoded} segments encoded, ${res.reused} reused)`;
};
