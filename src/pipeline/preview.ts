// Preview stage: edit → timeline → 720p preview.mp4 from the segment cache.
// Also writes out/preview.json with the edit version it was built from, so the UI can tell
// (from data, not event order) whether the preview matches the current cut.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths } from "../core/paths.ts";
import { loadEditInputs } from "./load.ts";
import { fmtDuration, withDeps, type StageFn } from "./types.ts";

export type PreviewStageOptions = { sweep?: boolean } | undefined;

export const previewStage: StageFn<PreviewStageOptions> = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const build = async (label: string) => {
    const { project, config, timeline, edit } = await loadEditInputs(slug, d);
    const res = await d.buildPreview(slug, timeline, {
      signal: ctx.signal,
      config,
      clips: project.clips,
      framing: project.speakerSide,
      onProgress: (f, msg) => ctx.progress(f, `${label}${msg}`),
    });
    await writeFile(join(projectPaths(slug).outDir, "preview.json"), JSON.stringify({ editVersion: edit.version, duration: res.duration, builtAt: new Date().toISOString() }) + "\n");
    return res;
  };
  let res = await build("");
  let sweepNote = "";
  // After Claude's plan: listen to the preview and cut any um/uh that is still audible.
  if (ctx.options?.sweep) {
    ctx.progress(undefined, "Listening to the preview for leftover ums");
    // Up to two passes: cutting one um can make the next one audible in a different context.
    let cut = 0, heard = 0, restored = 0;
    for (let pass = 1; pass <= 2; pass++) {
      const sw = await d.sweepResidualFillers(slug, { signal: ctx.signal });
      if (pass === 1) heard = sw.heardFillers;
      cut += sw.added;
      restored += sw.restored;
      if (!sw.added && !sw.restored) break;
      ctx.emit({ type: "bundle-changed" });
      res = await build(`Rebuilding (pass ${pass}): `);
    }
    sweepNote = heard ? ` · listen-back cut ${cut} leftover ${cut === 1 ? "um" : "ums"}` : " · listen-back: no leftover ums";
    if (restored) sweepNote += `, restored ${restored} ${restored === 1 ? "cut" : "cuts"} that clipped speech`;
  }
  return `Preview ready: ${fmtDuration(res.duration)} (${res.encoded} segments encoded, ${res.reused} reused)${sweepNote}`;
};
