// Conformed master: one re-encode of a clip with its picture fixes baked in (letterbox crop, mirror,
// stabilization), same frames and timing as the original. Everything that reads a clip's video (proxy,
// render segments, dissolves) reads the master when the clip needs one, so a fix is applied once. Audio
// is always taken from the original. The master's name carries a signature of the source and the fixes,
// so changing a fix makes a new master (and new segment cache keys) instead of reusing a stale one.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, projectPaths } from "../core/paths.ts";
import { ffmpeg, run } from "../core/proc.ts";
import type { Clip, Project } from "../core/schema.ts";
import { atomicOutput, cropFilter, type MediaOptions } from "./prepare.ts";

const STABILIZER = join(REPO_ROOT, "scripts", "stabilize.py");
const MASTER_VERSION = 1; // bump when the master recipe changes

export const needsMaster = (clip: Pick<Clip, "mirror" | "stabilize">) => Boolean(clip.mirror || clip.stabilize);

/** sha1 of the source identity and the fixes, 12 hex chars. */
export function masterSignature(clip: Clip, framing: Project["speakerSide"]): string {
  const s = existsSync(clip.path) ? statSync(clip.path) : { mtimeMs: 0, size: 0 };
  return createHash("sha1")
    .update(JSON.stringify([MASTER_VERSION, clip.path, Math.round(s.mtimeMs), s.size, clip.crop ?? null, !!clip.mirror, !!clip.stabilize, clip.stabilize ? framing : null]))
    .digest("hex")
    .slice(0, 12);
}

export const mediaDir = (slug: string) => join(projectPaths(slug).root, "media");
export const masterPath = (slug: string, clip: Clip, framing: Project["speakerSide"]) =>
  join(mediaDir(slug), `${clip.id}.${masterSignature(clip, framing)}.master.mp4`);

/**
 * Where to read a clip's picture from: its master (fixes baked in, so no crop on top) when it needs one,
 * otherwise the original with the letterbox crop applied by the encoder.
 */
export function videoSource(slug: string, clip: Clip, framing: Project["speakerSide"]): { path: string; crop?: Clip["crop"] } {
  if (!needsMaster(clip)) return { path: clip.path, crop: clip.crop };
  const master = masterPath(slug, clip, framing);
  if (!existsSync(master)) throw new Error(`${clip.name}: its conformed master isn't built yet (run Import)`);
  return { path: master };
}

/** Python with OpenCV: the system one if it has cv2, else the pinned official package through uv. */
let pythonCmd: Promise<string[]> | null = null;
export function stabilizerPython(): Promise<string[]> {
  pythonCmd ??= run("python3", ["-c", "import cv2, numpy"])
    .then(() => ["python3"])
    .catch(() => ["uv", "run", "--no-project", "--with", "opencv-python-headless==4.12.0.88", "--with", "numpy", "python"]);
  return pythonCmd;
}

const MASK: Record<Project["speakerSide"], string> = { left: "left", center: "center", right: "right" };

/** Build the clip's master if it needs one and it isn't there yet; older masters of the clip are removed. */
export async function ensureMaster(slug: string, clip: Clip, framing: Project["speakerSide"], opts: MediaOptions = {}): Promise<string | null> {
  if (!needsMaster(clip)) return null;
  const out = masterPath(slug, clip, framing);
  if (existsSync(out)) return out;
  const dir = mediaDir(slug);
  const log = opts.log ?? join(projectPaths(slug).runsDir, "conform.log");
  const crop = clip.crop ? ["--crop", `${clip.crop.w}:${clip.crop.h}:${clip.crop.x}:${clip.crop.y}`] : [];
  const mirror = clip.mirror ? ["--mirror"] : [];

  if (clip.stabilize) {
    const py = await stabilizerPython();
    const analysis = out.replace(/\.master\.mp4$/, ".stab.json");
    opts.onProgress?.(0, `${clip.name}: measuring camera shake`);
    await run(py[0]!, [...py.slice(1), STABILIZER, "analyze", clip.path, analysis, ...crop, ...mirror, "--mask", MASK[framing]], { signal: opts.signal, log });
    opts.onProgress?.(0.3, `${clip.name}: stabilizing`);
    await atomicOutput(out, (part) => run(py[0]!, [...py.slice(1), STABILIZER, "apply", clip.path, analysis, part], {
      signal: opts.signal,
      log,
      onStdoutLine: (l) => {
        const m = /^progress ([\d.]+)/.exec(l);
        if (m) opts.onProgress?.(0.3 + 0.7 * Number(m[1]), `${clip.name}: stabilizing`);
      },
    }));
  } else {
    opts.onProgress?.(0, `${clip.name}: conforming`);
    const vf = `${cropFilter(clip)}${clip.mirror ? "hflip," : ""}format=yuv420p`;
    await atomicOutput(out, (part) => ffmpeg([
      "-i", clip.path, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, "-fps_mode", "passthrough",
      "-c:v", "hevc_videotoolbox", "-q:v", "80", "-tag:v", "hvc1",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-c:a", "copy", "-movflags", "+faststart", "-f", "mp4", part,
    ], { signal: opts.signal, log }));
  }

  // older masters of this clip (made before a fix changed) are no longer used
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith(`${clip.id}.`) && (f.endsWith(".master.mp4") || f.endsWith(".stab.json")) && !out.endsWith(f) && !out.replace(/\.master\.mp4$/, ".stab.json").endsWith(f)) {
      await rm(join(dir, f), { force: true });
    }
  }
  opts.onProgress?.(1, `${clip.name}: conformed`);
  return out;
}
