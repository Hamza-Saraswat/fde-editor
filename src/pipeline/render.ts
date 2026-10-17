// Render stage: final.mp4 with every enabled graphic, intro/outro, loudnorm; then the upload sidecars
// (chapters.txt, captions.srt) and out/render.json (the X-clip stage reads the intro length from it).
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { projectPaths } from "../core/paths.ts";
import { writeJson } from "../core/store.ts";
import { chaptersText, srtFromTimeline } from "../media/sidecars.ts";
import { loadEditInputs, renderInfoPath, RenderInfoSchema } from "./load.ts";
import { scriptSpellingMap } from "./spelling.ts";
import { errorMessage, fmtDuration, plural, withDeps, type StageFn } from "./types.ts";

export const renderStage: StageFn = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const paths = projectPaths(slug);
  const { project, config, edit, transcript, script, timeline } = await loadEditInputs(slug, d);

  // timeline.overlays holds only the enabled overlays that landed in the cut
  const statuses = await d.graphicStatuses(slug);
  const missing = [...new Set(timeline.overlays.filter((o) => !statuses[o.cueId]?.hasMov).map((o) => o.cueId))];
  if (missing.length) throw new Error(`Graphics missing for: ${missing.join(", ")} — run Graphics first`);
  const stale = [...new Set(timeline.overlays.filter((o) => statuses[o.cueId]?.stale).map((o) => o.cueId))];
  if (stale.length) ctx.emit({ type: "log", stage: "render", line: `warning: rendering with out-of-date graphics: ${stale.join(", ")}` });

  const overlays = timeline.overlays.map((o) => ({ cueId: o.cueId, file: paths.graphicMov(o.cueId), start: o.start, end: o.end }));
  const notes: string[] = [];
  // Intro is shared by every video; the end card is rendered per video with its "next up" title.
  const side = async (wanted: boolean, label: string, make: () => Promise<string | null>) => {
    if (!wanted) return undefined;
    try {
      ctx.progress(undefined, `Preparing the ${label}`);
      const file = await make();
      if (file && existsSync(file)) return file;
      notes.push(`no ${label} (brand template missing)`);
    } catch (err) {
      notes.push(`no ${label} (${errorMessage(err).slice(0, 120)})`);
    }
    return undefined;
  };
  const intro = await side(edit.intro, "intro", () => d.ensureIntro({ signal: ctx.signal }));
  const outro = await side(edit.outro, "end card", () => d.ensureOutro(paths.cacheDir, project.nextVideoTitle, { signal: ctx.signal }));

  const res = await d.renderFinal(slug, timeline, {
    overlays,
    intro,
    outro,
    signal: ctx.signal,
    config,
    clips: project.clips,
    framing: project.speakerSide,
    onProgress: (f, msg) => ctx.progress(f * 0.97, msg),
  });

  ctx.progress(0.98, "Writing chapters and captions");
  await mkdir(paths.outDir, { recursive: true });
  const chapters = chaptersText(timeline.chapters, res.introSeconds, res.duration); // "" when fewer than 3 chapters fit
  await writeFile(paths.chapters, chapters ? `${chapters}\n` : "");
  const spelling = script ? scriptSpellingMap(script, transcript, edit) : undefined;
  await writeFile(paths.srt, srtFromTimeline(transcript.words, timeline, res.introSeconds, spelling));
  await writeJson(renderInfoPath(slug), RenderInfoSchema, {
    introSeconds: res.introSeconds,
    arollSeconds: res.arollSeconds,
    outroSeconds: res.outroSeconds,
    duration: res.duration,
    renderedAt: new Date().toISOString(),
  });

  const parts = [`Final ready: ${fmtDuration(res.duration)}`, plural(overlays.length, "graphic")];
  if (intro) parts.push("intro");
  if (outro) parts.push("outro");
  return [...parts, ...notes].join(" · ");
};
