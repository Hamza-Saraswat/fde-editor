// Preview and final renders on top of the segment cache, plus X (Twitter) clip cutting.
//
// preview: cached 720p segments -> concat demuxer (-c copy) -> mux with AAC. A toggled cut only
//          costs the new segments plus a fast concat.
// final:   cached full-size HEVC segments -> A-roll (video + wav) -> one ffmpeg pass that lays the
//          transparent HyperFrames graphics over the A-roll, joins intro/outro, applies two-pass
//          loudnorm and encodes the YouTube upload. Durations are frame/sample exact.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ffmpeg, ffprobeJson } from "../core/proc.ts";
import { projectPaths } from "../core/paths.ts";
import { loadConfig } from "../core/store.ts";
import type { Timeline } from "../core/schema.ts";
import { SAMPLE_RATE, atomicOutput, progressReader, type MediaOptions, type Progress } from "./prepare.ts";
import { ensureSegments, type EnsureOptions } from "./segments.ts";
import { loudnormFilter, measureLoudness, type LoudnessMeasurement } from "./loudness.ts";
import { parseRate, type ProbeJson } from "./probe.ts";

// ---------- pure builders (unit-tested) ----------

/** Concat-demuxer list file body. Single quotes in paths are escaped the way ffmpeg expects. */
export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** Seconds as a short decimal string for filter expressions (µs precision, never exponent form). */
export const secs = (x: number) => String(Math.round(x * 1e6) / 1e6);

export type OverlaySpec = { start: number; end: number; width?: number; height?: number }; // A-roll seconds

/**
 * Filtergraph that composites each transparent graphic over the A-roll at its own time:
 *   [gN:v]setpts=PTS-STARTPTS+<start>/TB[ovN]; [prev][ovN]overlay=0:0:eof_action=pass:format=auto:enable='between(t,s,e)'
 * Graphics whose size differs from the output are scaled first (alpha is kept).
 */
export function overlayFiltergraph(
  overlays: OverlaySpec[],
  o: { mainIn: string; firstInput: number; width: number; height: number; out: string },
): string {
  if (!overlays.length) return `${o.mainIn}null${o.out}`;
  const parts: string[] = [];
  let prev = o.mainIn;
  overlays.forEach((ov, i) => {
    const needsScale = ov.width !== undefined && ov.height !== undefined && (ov.width !== o.width || ov.height !== o.height);
    const scale = needsScale ? `scale=${o.width}:${o.height},` : "";
    parts.push(`[${o.firstInput + i}:v]${scale}setpts=PTS-STARTPTS+${secs(ov.start)}/TB[ov${i}]`);
    const out = i === overlays.length - 1 ? o.out : `[m${i}]`;
    parts.push(`${prev}[ov${i}]overlay=0:0:eof_action=pass:format=auto:enable='between(t,${secs(ov.start)},${secs(ov.end)})'${out}`);
    prev = out;
  });
  return parts.join(";");
}

export type SideClip = {
  file: string;
  frames: number; // conformed length at the output fps
  samples: number; // = frames * 48000 / fps
  hasAudio: boolean;
  alpha: boolean;
  width: number;
  height: number;
};

const fitFilter = (W: number, H: number) =>
  `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

/** Intro/outro video conformed to the output: fit + pad, fps, yuv420p, exactly `frames` frames. Alpha goes over black. */
export function sideVideoChain(input: number, side: Pick<SideClip, "frames" | "alpha">, W: number, H: number, fps: number, out: string): string {
  const fit = `${fitFilter(W, H)},fps=${fps}`;
  const tail = `format=yuv420p,tpad=stop=-1:stop_mode=clone,trim=end_frame=${side.frames},setpts=PTS-STARTPTS${out}`;
  if (!side.alpha) return `[${input}:v]${fit},${tail}`;
  return `color=c=black:s=${W}x${H}:r=${fps}[bg${input}];[${input}:v]${fit}[fg${input}];` +
    `[bg${input}][fg${input}]overlay=0:0:shortest=1:format=auto,${tail}`;
}

/** Audio for one piece of the final mix: 48 kHz stereo, exactly `samples` long (silence when `input` is null). */
export function sideAudioChain(input: number | null, samples: number, out: string): string {
  if (input === null) return `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${samples}${out}`;
  return `[${input}:a:0]aresample=${SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=stereo,` +
    `apad=whole_len=${samples},atrim=end_sample=${samples}${out}`;
}

/** Bitrate for the YouTube master: 45 Mb/s at 1440p30, scaled by pixel rate. */
export function finalBitrateMbps(width: number, height: number, fps: number): number {
  return Math.max(4, Math.round((45 * width * height * fps) / (2560 * 1440 * 30)));
}

const COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
/** VideoToolbox only writes the VUI tags the frames carry (output flags alone left primaries/trc "unknown"). */
export const TAG_BT709 = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709";

export function finalEncodeArgs(o: { width: number; height: number; fps: number; frames: number }): string[] {
  return [
    "-c:v", "h264_videotoolbox", "-b:v", `${finalBitrateMbps(o.width, o.height, o.fps)}M`, "-profile:v", "high",
    "-pix_fmt", "yuv420p", "-g", String(Math.max(1, Math.round(o.fps / 2))), // YouTube: closed GOP of half the frame rate
    "-r", String(o.fps), "-fps_mode", "cfr", "-frames:v", String(o.frames),
    ...COLOR_TAGS,
    "-c:a", "aac", "-b:a", "256k", "-ar", String(SAMPLE_RATE), "-ac", "2",
    "-movflags", "+faststart",
  ];
}

// ---------- helpers ----------

/** Maps a child step's 0–1 progress into [a, b] of the parent. */
const sub = (p: Progress | undefined, a: number, b: number): Progress | undefined => (p ? (f, m) => p(a + (b - a) * f, m) : undefined);

const ALPHA_PIX = /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr)/;

/** Probe an intro/outro and work out its frame-exact length at `fps`. */
export async function probeSide(file: string, fps: number, opts: Pick<MediaOptions, "signal" | "log"> = {}): Promise<SideClip> {
  const j = (await ffprobeJson(file, opts)) as ProbeJson;
  const v = j.streams?.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error(`${basename(file)} has no video stream`);
  const dur = Number(v.duration ?? j.format?.duration ?? NaN);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`${basename(file)}: could not read duration`);
  const frames = Math.max(1, Math.round(dur * fps));
  return {
    file,
    frames,
    samples: Math.round((frames * SAMPLE_RATE) / fps),
    hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
    alpha: ALPHA_PIX.test(v.pix_fmt ?? ""),
    width: v.width ?? 0,
    height: v.height ?? 0,
  };
}

async function probeSize(file: string, opts: Pick<MediaOptions, "signal" | "log">) {
  const j = (await ffprobeJson(file, opts)) as ProbeJson;
  const v = j.streams?.find((s) => s.codec_type === "video");
  return { width: v?.width ?? 0, height: v?.height ?? 0, fps: parseRate(v?.r_frame_rate) || 30, duration: Number(j.format?.duration ?? v?.duration ?? 0) };
}

async function concatCopy(listFile: string, files: string[], out: string, opts: { signal?: AbortSignal; log?: string }) {
  await writeFile(listFile, concatList(files));
  const fmt = out.endsWith(".wav") ? "wav" : "mp4";
  await atomicOutput(out, (part) => ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-f", fmt, part], opts));
}

// ---------- preview ----------

export type PreviewResult = { path: string; frames: number; duration: number; encoded: number; reused: number; ms: number };

export async function buildPreview(slug: string, timeline: Timeline, opts: EnsureOptions = {}): Promise<PreviewResult> {
  const t0 = Date.now();
  if (!timeline.segments.length) throw new Error("Nothing to preview: the timeline has no segments");
  const p = projectPaths(slug);
  const log = opts.log ?? join(p.runsDir, "preview.log");
  const segs = await ensureSegments(slug, timeline, "preview", { ...opts, log, onProgress: sub(opts.onProgress, 0, 0.9) });
  await mkdir(p.cacheDir, { recursive: true });
  const vList = join(p.cacheDir, "preview.video.txt");
  const aList = join(p.cacheDir, "preview.audio.txt");
  await writeFile(vList, concatList(segs.files.map((f) => f.video)));
  await writeFile(aList, concatList(segs.files.map((f) => f.audio)));
  opts.onProgress?.(0.9, "Joining preview");
  await atomicOutput(p.preview, (part) => ffmpeg([
    "-f", "concat", "-safe", "0", "-i", vList,
    "-f", "concat", "-safe", "0", "-i", aList,
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", String(SAMPLE_RATE),
    "-movflags", "+faststart", "-f", "mp4", part,
  ], { signal: opts.signal, log }));
  opts.onProgress?.(1, "Preview ready");
  return { path: p.preview, frames: segs.frames, duration: segs.frames / timeline.fps, encoded: segs.encoded, reused: segs.reused, ms: Date.now() - t0 };
}

// ---------- final ----------

/** A rendered transparent graphic (ProRes 4444 .mov) and when it shows, in A-roll seconds. */
export type GraphicOverlay = { cueId: string; file: string; start: number; end: number };

export type FinalOptions = EnsureOptions & { overlays: GraphicOverlay[]; intro?: string; outro?: string };

export type FinalResult = {
  path: string;
  frames: number;
  duration: number;
  introSeconds: number; // shift sidecars (chapters, captions) by this
  arollSeconds: number;
  outroSeconds: number;
  loudness: LoudnessMeasurement;
  encoded: number;
  reused: number;
  ms: number;
};

export async function renderFinal(slug: string, timeline: Timeline, opts: FinalOptions): Promise<FinalResult> {
  const t0 = Date.now();
  if (!timeline.segments.length) throw new Error("Nothing to render: the timeline has no segments");
  const config = opts.config ?? (await loadConfig());
  const p = projectPaths(slug);
  const log = opts.log ?? join(p.runsDir, "render.log");
  const run = { signal: opts.signal, log };
  const fps = timeline.fps;
  const { width: W, height: H } = config.output;

  // a) A-roll from the segment cache
  const segs = await ensureSegments(slug, timeline, "final", { ...opts, config, log, onProgress: sub(opts.onProgress, 0, 0.55) });
  await mkdir(p.cacheDir, { recursive: true });
  const arollMp4 = join(p.cacheDir, "aroll.mp4");
  const arollWav = join(p.cacheDir, "aroll.wav");
  opts.onProgress?.(0.55, "Joining A-roll");
  await concatCopy(join(p.cacheDir, "final.video.txt"), segs.files.map((f) => f.video), arollMp4, run);
  await concatCopy(join(p.cacheDir, "final.audio.txt"), segs.files.map((f) => f.audio), arollWav, run);
  const arollFrames = segs.frames;
  const arollSamples = Math.round((arollFrames * SAMPLE_RATE) / fps);

  // c) intro / outro, conformed to whole frames
  const intro = opts.intro ? await probeSide(opts.intro, fps, run) : null;
  const outro = opts.outro ? await probeSide(opts.outro, fps, run) : null;
  const totalFrames = (intro?.frames ?? 0) + arollFrames + (outro?.frames ?? 0);
  const totalSamples = Math.round((totalFrames * SAMPLE_RATE) / fps);

  // d) the full programme audio (intro + A-roll + outro) as one wav, then loudness pass 1 on it
  let mixWav = arollWav;
  if (intro || outro) {
    mixWav = join(p.cacheDir, "mix.wav");
    const inputs: string[] = [];
    const chains: string[] = [];
    const labels: string[] = [];
    const piece = (file: string | null, samples: number, label: string) => {
      let idx: number | null = null;
      if (file) {
        idx = inputs.length / 2;
        inputs.push("-i", file);
      }
      chains.push(sideAudioChain(idx, samples, `[${label}]`));
      labels.push(`[${label}]`);
    };
    if (intro) piece(intro.hasAudio ? intro.file : null, intro.samples, "ai");
    piece(arollWav, arollSamples, "am");
    if (outro) piece(outro.hasAudio ? outro.file : null, outro.samples, "ao");
    const graph = `${chains.join(";")};${labels.join("")}concat=n=${labels.length}:v=0:a=1[a]`;
    opts.onProgress?.(0.58, "Mixing intro/outro audio");
    await atomicOutput(mixWav, (part) => ffmpeg([...inputs, "-filter_complex", graph, "-map", "[a]", "-c:a", "pcm_s16le", "-f", "wav", part], run));
  }
  opts.onProgress?.(0.6, "Measuring loudness");
  const measured = await measureLoudness(mixWav, config.loudness, run);

  // b) + e) graphics over the A-roll, intro/outro join, loudnorm, encode — one pass
  const overlays = opts.overlays
    .map((o) => ({ ...o, start: Math.max(0, o.start), end: Math.min(o.end, arollFrames / fps) }))
    .filter((o) => o.end > o.start)
    .sort((a, b) => a.start - b.start);
  const overlaySizes = await Promise.all(overlays.map((o) => probeSize(o.file, run)));
  const args: string[] = ["-progress", "pipe:1", "-i", arollMp4];
  for (const o of overlays) args.push("-i", o.file);
  const graph: string[] = [overlayFiltergraph(
    overlays.map((o, i) => ({ start: o.start, end: o.end, width: overlaySizes[i]!.width, height: overlaySizes[i]!.height })),
    { mainIn: "[0:v]", firstInput: 1, width: W, height: H, out: "[main]" },
  )];
  let nextInput = 1 + overlays.length;
  const vLabels: string[] = [];
  if (intro) {
    args.push("-i", intro.file);
    graph.push(sideVideoChain(nextInput++, intro, W, H, fps, "[vi]"));
    vLabels.push("[vi]");
  }
  vLabels.push("[main]");
  if (outro) {
    args.push("-i", outro.file);
    graph.push(sideVideoChain(nextInput++, outro, W, H, fps, "[vo]"));
    vLabels.push("[vo]");
  }
  graph.push(vLabels.length > 1
    ? `${vLabels.join("")}concat=n=${vLabels.length}:v=1:a=0,format=yuv420p,${TAG_BT709}[v]`
    : `[main]format=yuv420p,${TAG_BT709}[v]`);
  args.push("-i", mixWav);
  graph.push(`[${nextInput}:a:0]${loudnormFilter(config.loudness, measured)},aresample=${SAMPLE_RATE},` +
    `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[a]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]",
    ...finalEncodeArgs({ width: W, height: H, fps, frames: totalFrames }));

  const encode = sub(opts.onProgress, 0.62, 1);
  encode?.(0, "Rendering final");
  await mkdir(p.outDir, { recursive: true });
  await atomicOutput(p.final, (part) => ffmpeg([...args, "-f", "mp4", part], {
    ...run,
    onStdoutLine: progressReader(totalFrames / fps, (f) => encode?.(f, "Rendering final")),
  }));
  opts.onProgress?.(1, "Final render ready");

  return {
    path: p.final,
    frames: totalFrames,
    duration: totalFrames / fps,
    introSeconds: (intro?.frames ?? 0) / fps,
    arollSeconds: arollFrames / fps,
    outroSeconds: (outro?.frames ?? 0) / fps,
    loudness: measured,
    encoded: segs.encoded,
    reused: segs.reused,
    ms: Date.now() - t0,
  };
}

// ---------- X clips ----------

/**
 * Cut [start, end] (final-render seconds) out of the final render with an accurate seek and a
 * re-encode, optionally burn in a transparent captions .mov (starting at the clip's 0), and
 * write a 16:9 H.264/AAC file no wider than 1920 px.
 */
export async function renderXClip(
  slug: string,
  finalPath: string,
  clip: { start: number; end: number },
  captionOverlay: string | undefined,
  outPath: string,
  opts: MediaOptions & { maxWidth?: number } = {},
): Promise<{ path: string; frames: number; duration: number }> {
  const run = { signal: opts.signal, log: opts.log ?? join(projectPaths(slug).runsDir, "xclips.log") };
  const src = await probeSize(finalPath, run);
  const fps = Math.round(src.fps * 1000) / 1000;
  const start = Math.max(0, clip.start);
  const end = Math.min(clip.end, src.duration);
  if (end <= start) throw new Error(`X clip ${clip.start}–${clip.end}s is empty or outside the render (${src.duration}s)`);
  const frames = Math.max(1, Math.round((end - start) * fps));
  const W = 2 * Math.round(Math.min(src.width || 1920, opts.maxWidth ?? 1920) / 2);
  const H = 2 * Math.round((W * 9) / 16 / 2);
  const base = `[0:v]${fitFilter(W, H)}[base]`;
  const graph = captionOverlay
    ? `${base};[1:v]scale=${W}:${H}[cap];[base][cap]overlay=0:0:eof_action=pass:format=auto,format=yuv420p,${TAG_BT709}[v]`
    : `${base};[base]format=yuv420p,${TAG_BT709}[v]`;
  const mbps = Math.max(2, Math.round((10 * W * H * fps) / (1920 * 1080 * 30)));
  const args = [
    "-progress", "pipe:1",
    "-ss", secs(start), "-t", secs(end - start), "-i", finalPath,
    ...(captionOverlay ? ["-i", captionOverlay] : []),
    "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?",
    "-c:v", "h264_videotoolbox", "-b:v", `${mbps}M`, "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-g", String(Math.round(fps)), "-r", String(fps), "-fps_mode", "cfr", "-frames:v", String(frames),
    ...COLOR_TAGS,
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2",
    "-movflags", "+faststart",
  ];
  await atomicOutput(outPath, (part) => ffmpeg([...args, "-f", "mp4", part], {
    ...run,
    onStdoutLine: progressReader(end - start, (f) => opts.onProgress?.(f, "Cutting X clip")),
  }));
  opts.onProgress?.(1, "X clip ready");
  return { path: outPath, frames, duration: frames / fps };
}
