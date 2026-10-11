// Read a recording's stream facts (size, fps, VFR, HDR, audio) with ffprobe.
import { basename } from "node:path";
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
  return clipFromProbe((await ffprobeJson(path, opts)) as ProbeJson, path, id);
}
