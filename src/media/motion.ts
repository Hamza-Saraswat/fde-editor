// Picture motion of a clip, for catching a hand on the camera. One value per frame: the mean luma change
// from the previous frame (ffmpeg signalstats YDIF) of the proxy scaled to 160 px wide. Talking barely
// moves the picture; a reach to the phone sweeps an arm across all of it (about ten times the clip's
// usual motion). Computed once per proxy and cached in the project's cache folder.
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ffmpeg, ffprobeJson, type RunOptions } from "../core/proc.ts";
import { projectPaths } from "../core/paths.ts";
import type { Clip } from "../core/schema.ts";

export type Motion = { fps: number; ydif: Float32Array; median: number };
export type Span = { start: number; end: number };

/** Pure: per-frame YDIF values from `metadata=print` output, in frame order. */
export function parseYdif(out: string): number[] {
  const values: number[] = [];
  for (const m of out.matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)) values.push(Number(m[1]));
  return values;
}

export function motionOf(values: ArrayLike<number>, fps: number): Motion {
  const ydif = Float32Array.from(values);
  const sorted = Float32Array.from(ydif).sort();
  return { fps, ydif, median: sorted[Math.floor(sorted.length / 2)] ?? 0 };
}

/**
 * Pure: the spans where motion runs at `factor` × the clip's median or more for at least `minFrames`
 * frames, merging spans less than `bridge` seconds apart (an arm going out and coming back is one reach).
 */
export function motionSpans(m: Motion, factor: number, minFrames = 3, bridge = 0.4): Span[] {
  const thr = Math.max(factor * m.median, 0.5);
  const raw: Span[] = [];
  let from = -1;
  for (let i = 0; i <= m.ydif.length; i++) {
    const hot = i < m.ydif.length && m.ydif[i]! >= thr;
    if (hot && from < 0) from = i;
    if (!hot && from >= 0) {
      raw.push({ start: from / m.fps, end: i / m.fps });
      from = -1;
    }
  }
  const merged: Span[] = [];
  for (const s of raw) {
    const prev = merged.at(-1);
    if (prev && s.start - prev.end < bridge) prev.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => (s.end - s.start) * m.fps >= minFrames);
}

const motionFile = (slug: string, clipId: string) => join(projectPaths(slug).cacheDir, `motion-${clipId}.json`);

type Cached = { source: string; mtimeMs: number; size: number; fps: number; ydif: number[] };

/** The clip's cached motion, if it was measured from the current proxy. */
export async function loadMotion(slug: string, clip: Pick<Clip, "id">): Promise<Motion | null> {
  const proxy = projectPaths(slug).proxy(clip.id);
  const file = motionFile(slug, clip.id);
  if (!existsSync(file) || !existsSync(proxy)) return null;
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Cached;
    const st = statSync(proxy);
    if (c.source !== proxy || Math.round(st.mtimeMs) !== c.mtimeMs || st.size !== c.size) return null;
    return motionOf(c.ydif, c.fps);
  } catch {
    return null;
  }
}

/** Measure (or load) the clip's motion from its proxy. Null when there is no proxy yet. */
export async function ensureMotion(slug: string, clip: Pick<Clip, "id">, opts: RunOptions = {}): Promise<Motion | null> {
  const cached = await loadMotion(slug, clip);
  if (cached) return cached;
  const proxy = projectPaths(slug).proxy(clip.id);
  if (!existsSync(proxy)) return null;
  const probe = await ffmpeg(["-i", proxy, "-an", "-vf", "scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-", "-f", "null", "-"], opts);
  const fps = await proxyFps(proxy, opts);
  const values = parseYdif(probe.stdout);
  const st = statSync(proxy);
  const cache: Cached = { source: proxy, mtimeMs: Math.round(st.mtimeMs), size: st.size, fps, ydif: values.map((v) => Math.round(v * 100) / 100) };
  const file = motionFile(slug, clip.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache) + "\n");
  return motionOf(cache.ydif, fps);
}

async function proxyFps(file: string, opts: RunOptions): Promise<number> {
  const info = (await ffprobeJson(file, opts)) as { streams?: { codec_type?: string; avg_frame_rate?: string }[] };
  const [n, d] = (info.streams?.find((s) => s.codec_type === "video")?.avg_frame_rate ?? "30/1").split("/").map(Number);
  return n && d ? n / d : 30;
}

/** Motion of every clip with a proxy; measures the ones not cached yet. */
export async function loadClipMotion(slug: string, clips: Pick<Clip, "id">[], opts: RunOptions & { measure?: boolean } = {}): Promise<Map<string, Motion>> {
  const out = new Map<string, Motion>();
  for (const clip of clips) {
    const m = opts.measure ? await ensureMotion(slug, clip, opts) : await loadMotion(slug, clip);
    if (m) out.set(clip.id, m);
  }
  return out;
}
