// Apply a video's edit style to its cuts: filler policy (style.ts), then the join pass (joins.ts) with
// the clips' loudness envelopes and picture motion. Every place that changes cuts in bulk runs this:
// plan apply, the listen-back, and a style change from the review screen.
import { existsSync } from "node:fs";
import { projectPaths } from "../core/paths.ts";
import { ScriptDocSchema, TranscriptSchema, type Clip, type Config, type Edit, type ScriptDoc, type Transcript } from "../core/schema.ts";
import { readJson } from "../core/store.ts";
import { applyJoins } from "../core/joins.ts";
import { applyStyle, resolveStyle } from "../core/style.ts";
import { loadEnvelope, type Envelope } from "../media/energy.ts";
import { loadClipMotion, type Motion } from "../media/motion.ts";

/** Loudness envelopes of the clips' ASR audio (16 kHz), or their render audio when that is all there is. */
export async function loadClipEnvelopes(slug: string, clips: Clip[]): Promise<Map<string, Envelope>> {
  const paths = projectPaths(slug);
  const out = new Map<string, Envelope>();
  for (const clip of clips) {
    const f = [paths.asrWav(clip.id), paths.wav(clip.id)].find((x) => existsSync(x));
    if (f) out.set(clip.id, await loadEnvelope(f));
  }
  return out;
}

export async function restyle(
  slug: string,
  edit: Edit,
  ctx: { config: Config; clips: Clip[]; transcript?: Transcript; script?: ScriptDoc; envelopes?: Map<string, Envelope>; motion?: Map<string, Motion> },
): Promise<Edit> {
  const paths = projectPaths(slug);
  const transcript = ctx.transcript ?? (await readJson(paths.transcript, TranscriptSchema));
  const script = ctx.script ?? (await readJson(paths.script, ScriptDocSchema));
  const envelopes = ctx.envelopes ?? (await loadClipEnvelopes(slug, ctx.clips));
  // measured once per proxy (a few seconds per clip), then cached
  const motion = ctx.motion ?? (await loadClipMotion(slug, ctx.clips, { measure: true }));
  const style = resolveStyle(ctx.config, edit);
  return applyJoins(applyStyle(edit, style), { transcript, script, envelopes, style, motion, clips: ctx.clips });
}
