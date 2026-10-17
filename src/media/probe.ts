// Read a recording's stream facts (size, fps, VFR, HDR, audio) with ffprobe.
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { ffprobeJson, type RunOptions } from "../core/proc.ts";
import type { Clip } from "../core/schema.ts";

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  color_transfer?: string;
  color_primaries?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
};
export type ProbeJson = { streams?: ProbeStream[]; format?: { duration?: string } };

/** "30000/1001" -> 29.97; "0/0", "", garbage -> 0. */
export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  return d > 0 && Number.isFinite(d) ? n / d : 0;
}

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Pure: turn `ffprobe -show_streams -show_format -of json` output into a Clip. */
export function clipFromProbe(json: ProbeJson, path: string, id: string): Clip {
  const name = basename(path);
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error(`${name} has no video stream`);
  const hasAudio = streams.some((s) => s.codec_type === "audio");

  const r = parseRate(video.r_frame_rate);
  const avg = parseRate(video.avg_frame_rate);
  // r_frame_rate is the stream's base rate; WebM/MediaRecorder files often report a
  // timebase-like value (1000/1) there, so fall back to the average when r is implausible.
  const rUsable = r > 0 && r <= 240;
  const fps = rUsable ? r : avg > 0 ? avg : 30;
  const vfr = !rUsable || avg <= 0 || Math.abs(avg - r) / r > 0.01;

  const pixFmt = video.pix_fmt ?? "";
  const highBitDepth = /p1[0-6]/.test(pixFmt);
  const hdr = HDR_TRANSFERS.has(video.color_transfer ?? "") || (highBitDepth && video.color_primaries === "bt2020");

  let width = video.width ?? 0;
  let height = video.height ?? 0;
  const rotation = video.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  const duration = Number(json.format?.duration ?? video.duration ?? NaN);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${name}: could not read duration`);

  return {
    id,
    name,
    path,
    duration,
    width,
    height,
    fps: round3(fps),
    codec: video.codec_name ?? "unknown",
    pixFmt,
    hasAudio,
    vfr,
    hdr,
  };
}

export async function probeClip(path: string, id: string, opts: RunOptions = {}): Promise<Clip> {
  const clip = clipFromProbe((await ffprobeJson(path, opts)) as ProbeJson, path, id);
  const crop = await detectLetterbox(path, clip);
  return crop ? { ...clip, crop, width: crop.w, height: crop.h } : clip;
}

// ---------- letterbox detection ----------

export type CropRect = { x: number; y: number; w: number; h: number };

/** Pure: the crop ffmpeg's cropdetect settled on (its last report), or null. */
export function parseCropdetect(stderr: string): CropRect | null {
  const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const m = all.at(-1);
  return m ? { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) } : null;
}

/**
 * Pure: is this a letterboxed recording worth cropping? Every sample must agree (within 4 px), the bars
 * must take at least 8 % of the frame, and the picture inside must be 16:9 (within 2 %). Dark footage
 * can fool cropdetect at one moment, but not into the same 16:9 box at three.
 */
export function letterboxFrom(samples: (CropRect | null)[], frame: { width: number; height: number }): CropRect | null {
  const first = samples[0];
  if (!first || samples.some((s) => !s || Math.abs(s.w - first.w) > 4 || Math.abs(s.h - first.h) > 4 || Math.abs(s.x - first.x) > 4 || Math.abs(s.y - first.y) > 4)) return null;
  if (first.w * first.h > 0.92 * frame.width * frame.height) return null;
  if (Math.abs(first.w / first.h / (16 / 9) - 1) > 0.02) return null;
  const even = (n: number) => n - (n % 2);
  return { x: even(first.x), y: even(first.y), w: even(first.w), h: even(first.h) };
}

/** Run cropdetect on three 3-second windows across the recording. */
export async function detectLetterbox(path: string, clip: Pick<Clip, "duration" | "width" | "height">): Promise<CropRect | null> {
  const at = [0.15, 0.5, 0.85].map((f) => Math.max(0, clip.duration * f - 1.5));
  const samples = await Promise.all(at.map((t) => new Promise<CropRect | null>((done) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-ss", t.toFixed(2), "-t", "3", "-i", path, "-an", "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"]);
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on("close", () => done(parseCropdetect(err)));
    p.on("error", () => done(null));
  })));
  return letterboxFrom(samples, clip);
}
