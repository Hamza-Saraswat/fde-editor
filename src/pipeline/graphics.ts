// Graphics stage: build every enabled overlay's graphic that is missing or stale (or the cues the
// user picked), one at a time. One failing cue never stops the others.
import type { GraphicStatus } from "../server/api.ts";
import { requireEdit } from "./load.ts";
import { errorMessage, plural, withDeps, type StageFn } from "./types.ts";

export type GraphicsStageOptions = { cueIds?: string[]; note?: string; force?: boolean };

/** Cues to build when the user did not pick any: enabled overlays whose graphic is not ready or is stale. */
export function graphicsTargets(overlays: { cueId: string; enabled: boolean }[], statuses: Record<string, GraphicStatus>): string[] {
  const out: string[] = [];
  for (const o of overlays) {
    if (!o.enabled || out.includes(o.cueId)) continue;
    const s = statuses[o.cueId];
    if (!s || s.state !== "ready" || s.stale) out.push(o.cueId);
  }
  return out;
}

const placeholder = (cueId: string, prev: GraphicStatus | undefined, state: GraphicStatus["state"], message: string): GraphicStatus => ({
  ...(prev ?? { cueId, hasMov: false, stale: false }),
  cueId,
  state,
  message,
  updatedAt: new Date().toISOString(),
});

export const graphicsStage: StageFn<GraphicsStageOptions | undefined> = async (slug, ctx, deps) => {
  const d = withDeps(deps);
  const o = ctx.options ?? {};
  const edit = await requireEdit(slug);
  const statuses = await d.graphicStatuses(slug);
  const targets = o.cueIds?.length ? [...new Set(o.cueIds)] : graphicsTargets(edit.overlays, statuses);
  if (!targets.length) return "All graphics are up to date";

  for (const cueId of targets) ctx.emit({ type: "graphic", status: placeholder(cueId, statuses[cueId], "queued", "Queued") });

  const failed: string[] = [];
  for (const [i, cueId] of targets.entries()) {
    ctx.signal.throwIfAborted();
    const at = (f: number) => (i + Math.min(1, Math.max(0, f))) / targets.length;
    ctx.progress(at(0), `${cueId}: building`);
    ctx.emit({ type: "graphic", status: placeholder(cueId, statuses[cueId], "building", "Claude is building the graphic") });
    try {
      const status = await d.buildGraphic(slug, cueId, {
        note: o.note,
        force: o.force,
        signal: ctx.signal,
        onEvent: (event) => ctx.emit({ type: "claude", stage: "graphics", cueId, event }),
        onProgress: (f, msg) => ctx.progress(at(f), `${cueId}: ${msg}`),
      });
      ctx.emit({ type: "graphic", status });
      if (status.state === "error") failed.push(`${cueId} (${status.message.slice(0, 120)})`);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      const message = errorMessage(err);
      failed.push(`${cueId} (${message.split("\n")[0]!.slice(0, 120)})`);
      ctx.emit({ type: "graphic", status: placeholder(cueId, statuses[cueId], "error", message.slice(0, 500)) });
      ctx.emit({ type: "log", stage: "graphics", line: `${cueId} failed: ${message}` });
    }
  }

  const built = targets.length - failed.length;
  if (built === 0) throw new Error(`All ${plural(targets.length, "graphic")} failed: ${failed.join("; ")}`);
  const msg = `${built}/${plural(targets.length, "graphic")} built`;
  return failed.length ? `${msg} · failed: ${failed.join("; ")}` : msg;
};
