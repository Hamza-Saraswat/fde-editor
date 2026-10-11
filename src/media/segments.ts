// Content-addressed segment cache: the core of preview and final render.
// Every kept Segment becomes one video-only file (frame-exact, -frames:v N) and one PCM piece
// (sample-exact, N * 48000 / fps samples). Concatenating them with the concat demuxer and
// `-c copy` gives 0 ms A/V drift (spikes/segment-sync.mjs: 200 segments, 0 ms).
// Keys hash the source identity + the frame range + the encode profile, so toggling a cut only
// encodes the segments that changed.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "../core/proc.ts";
import { projectPaths } from "../core/paths.ts";
import { loadConfig, loadProject } from "../core/store.ts";
import type { Clip, Segment, Timeline } from "../core/schema.ts";
import { SAMPLE_RATE, atomicOutput, prepareClip, type MediaOptions } from "./prepare.ts";

export type ProfileName = "preview" | "final";

/** The two encode profiles, in one place. */
export const PROFILES: Record<ProfileName, { maxHeight: number; codec: string[] }> = {
  preview: { maxHeight: 720, codec: ["-c:v", "h264_videotoolbox", "-q:v", "60"] },
  final: { maxHeight: Number.POSITIVE_INFINITY, codec: ["-c:v", "hevc_videotoolbox", "-q:v", "75", "-tag:v", "hvc1"] },
};

export type EncodeProfile = { name: ProfileName; width: number; height: number; fps: number; codecArgs: string[] };

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** Output size for a profile: final = config output size; preview = same aspect, at most 720 high. */
export function resolveProfile(name: ProfileName, output: { width: number; height: number }, fps: number): EncodeProfile {
  const h = Math.min(output.height, PROFILES[name].maxHeight);
  const height = even(h);
  const width = even((output.width * h) / output.height);
  return { name, width, height, fps, codecArgs: [...PROFILES[name].codec, "-g", String(fps)] };
}

/** Everything that changes the encoded pixels; part of the cache key. */
export const profileSignature = (p: EncodeProfile) => `${p.name}:${p.width}x${p.height}@${p.fps}:${p.codecArgs.join(" ")}`;

export type ClipStat = { mtimeMs: number; size: number };

export const startFrame = (seg: Pick<Segment, "start">, fps: number) => Math.round(seg.start * fps);

/** sha1(clip path + mtime/size + start frame + frame count + profile). */
export function segmentKey(clip: Pick<Clip, "path">, seg: Pick<Segment, "start" | "frames">, profile: string, fps: number, stat?: ClipStat): string {
  const s = stat ?? statSync(clip.path);
  return createHash("sha1")
    .update([clip.path, Math.round(s.mtimeMs), s.size, startFrame(seg, fps), seg.frames, fps, profile].join("\u0000"))
    .digest("hex");
}

/** Pure: ffmpeg args for one frame-exact, video-only segment (same recipe as the spike). */
export function videoSegmentArgs(src: string, seg: Pick<Segment, "start" | "frames">, profile: EncodeProfile, out: string): string[] {
  const { width: W, height: H, fps } = profile;
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    "format=yuv420p",
    "tpad=stop=-1:stop_mode=clone", // a segment that runs into the clip's end still gets exactly N frames
  ].join(",");
  return [
    "-ss", (startFrame(seg, fps) / fps).toFixed(6), "-i", src,
    "-an", "-sn", "-dn", "-frames:v", String(seg.frames),
    "-vf", vf, "-r", String(fps), "-fps_mode", "cfr",
    ...profile.codecArgs, "-video_track_timescale", "15360",
    "-f", "mp4", out,
  ];
}

export type WavLayout = { dataOffset: number; channels: number; sampleRate: number; bits: number; format: number };

/** Parse a RIFF/WAVE header to find where the PCM data starts. */
export async function readWavLayout(file: string): Promise<WavLayout | null> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let i = 12;
    let fmt: Omit<WavLayout, "dataOffset"> | null = null;
    while (i + 8 <= bytesRead) {
      const id = buf.toString("ascii", i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === "fmt ") {
        fmt = {
          format: buf.readUInt16LE(i + 8),
          channels: buf.readUInt16LE(i + 10),
          sampleRate: buf.readUInt32LE(i + 12),
          bits: buf.readUInt16LE(i + 22),
        };
      } else if (id === "data") {
        return fmt ? { ...fmt, dataOffset: i + 8 } : null;
      }
      i += 8 + size + (size & 1);
    }
    return null;
  } finally {
    await fh.close();
  }
}

/** Sample range [s0, s1) of a segment in the 48 kHz clip wav. */
export function sampleRange(seg: Pick<Segment, "start" | "frames">, fps: number): [number, number] {
  const f0 = startFrame(seg, fps);
  return [Math.round((f0 * SAMPLE_RATE) / fps), Math.round(((f0 + seg.frames) * SAMPLE_RATE) / fps)];
}

const fmtSec = (x: number) => x.toFixed(6);

/** The fade/pad chain applied to every audio piece (n = exact sample count). */
export function audioPieceFilter(n: number, fadeMs: number): string {
  const dur = n / SAMPLE_RATE;
  const fade = Math.min(fadeMs / 1000, dur / 2);
  const parts = [`atrim=end_sample=${n}`, "asetpts=PTS-STARTPTS", `apad=whole_len=${n}`];
  if (fade > 0) parts.push(`afade=t=in:d=${fmtSec(fade)}`, `afade=t=out:st=${fmtSec(dur - fade)}:d=${fmtSec(fade)}`);
  return parts.join(",");
}

/**
 * Pure: ffmpeg args for one sample-exact audio piece. With a parsed s16le/48k/stereo layout the
 * input is opened as raw PCM at the exact byte of sample s0 (O(1) seek, byte-identical to
 * atrim=start_sample, which has to stream the whole file up to the in-point). Otherwise falls
 * back to the spike's atrim=start_sample:end_sample. `wav === null` means the clip has no audio.
 */
export function audioPieceArgs(wav: string | null, layout: WavLayout | null, range: [number, number], fadeMs: number, out: string): string[] {
  const [s0, s1] = range;
  const n = s1 - s0;
  const tail = ["-ac", "2", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", out];
  if (!wav) return ["-f", "lavfi", "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`, "-af", `atrim=end_sample=${n}`, ...tail];
  if (layout && layout.format === 1 && layout.bits === 16 && layout.channels === 2 && layout.sampleRate === SAMPLE_RATE) {
    return [
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ch_layout", "stereo",
      "-skip_initial_bytes", String(layout.dataOffset + s0 * 4), "-i", wav,
      "-af", audioPieceFilter(n, fadeMs), ...tail,
    ];
  }
  return ["-i", wav, "-af", `atrim=start_sample=${s0}:end_sample=${s1},${audioPieceFilter(n, fadeMs)}`, ...tail];
}

export type SegmentFiles = { video: string; audio: string; key: string; audioKey: string };
export type EnsureResult = {
  profile: EncodeProfile;
  files: SegmentFiles[]; // in timeline order
  encoded: number; // segments (re)built on this call
  reused: number;
  frames: number; // total frames of the timeline
};

export type EnsureOptions = MediaOptions & {
  clips?: Clip[]; // defaults to project.json's clips
  concurrency?: number; // default 2 (VideoToolbox sessions)
};

export function segmentDirs(slug: string, profile: ProfileName) {
  const root = join(projectPaths(slug).cacheDir, "segments");
  return { video: join(root, profile), audio: join(root, "audio") };
}

/**
 * Run `fn` over items with at most `n` in flight. After a failure or an abort no new work starts,
 * and it only rejects once every in-flight job has settled (so .part files are already cleaned up).
 */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      if (signal?.aborted) {
        failed ??= signal.reason ?? new Error("cancelled");
        break;
      }
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failed) throw failed;
}

export async function ensureSegments(slug: string, timeline: Timeline, profileName: ProfileName, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const config = opts.config ?? (await loadConfig());
  const clips = opts.clips ?? (await loadProject(slug)).clips;
  const fps = timeline.fps;
  const profile = resolveProfile(profileName, config.output, fps);
  const sig = profileSignature(profile);
  const fadeMs = config.edit.fadeMs;
  const audioSig = `audio:${SAMPLE_RATE}:s16:stereo:fade${fadeMs}`;
  const dirs = segmentDirs(slug, profileName);
  const log = opts.log ?? join(projectPaths(slug).runsDir, `${profileName}.log`);

  const byId = new Map(clips.map((c) => [c.id, c]));
  const stats = new Map<string, ClipStat>();
  for (const seg of timeline.segments) {
    const clip = byId.get(seg.clipId);
    if (!clip) throw new Error(`Timeline references unknown clip ${seg.clipId}`);
    if (!Number.isInteger(seg.frames) || seg.frames <= 0) throw new Error(`Segment of ${seg.clipId} at ${seg.start}s has ${seg.frames} frames`);
    if (seg.start >= clip.duration) throw new Error(`Segment of ${clip.name} starts at ${seg.start}s, past the clip end (${clip.duration}s)`);
    if (!stats.has(clip.id)) {
      if (!existsSync(clip.path)) throw new Error(`${clip.name}: source recording not found at ${clip.path}`);
      stats.set(clip.id, statSync(clip.path));
    }
  }

  const files: SegmentFiles[] = timeline.segments.map((seg) => {
    const clip = byId.get(seg.clipId)!;
    const stat = stats.get(clip.id)!;
    const key = segmentKey(clip, seg, sig, fps, stat);
    const audioKey = segmentKey(clip, seg, audioSig, fps, stat);
    return { key, audioKey, video: join(dirs.video, `${key}.mp4`), audio: join(dirs.audio, `${audioKey}.wav`) };
  });

  // unique missing work, in timeline order
  type Job = { seg: Segment; clip: Clip; f: SegmentFiles; video: boolean; audio: boolean };
  const jobs: Job[] = [];
  const seen = new Set<string>();
  timeline.segments.forEach((seg, i) => {
    const f = files[i]!;
    const id = `${f.key}/${f.audioKey}`;
    if (seen.has(id)) return;
    seen.add(id);
    const video = !existsSync(f.video);
    const audio = !existsSync(f.audio);
    if (video || audio) jobs.push({ seg, clip: byId.get(seg.clipId)!, f, video, audio });
  });

  // clip wavs (render audio source) must exist before cutting pieces
  const layouts = new Map<string, WavLayout | null>();
  for (const clipId of new Set(jobs.filter((j) => j.audio && j.clip.hasAudio).map((j) => j.clip.id))) {
    const clip = byId.get(clipId)!;
    const { wav } = await prepareClip(slug, clip, { only: ["wav"], config, signal: opts.signal, log });
    layouts.set(clipId, await readWavLayout(wav));
  }

  const total = jobs.length;
  let done = 0;
  const label = profileName === "preview" ? "preview" : "final";
  opts.onProgress?.(total ? 0 : 1, total ? `Encoding ${total} ${label} segments` : `All ${files.length} ${label} segments cached`);

  await pool(jobs, opts.concurrency ?? 2, async (job) => {
    const { seg, clip, f } = job;
    if (job.video) await atomicOutput(f.video, (part) => ffmpeg(videoSegmentArgs(clip.path, seg, profile, part), { signal: opts.signal, log }));
    if (job.audio) {
      const wav = clip.hasAudio ? projectPaths(slug).wav(clip.id) : null;
      const layout = layouts.get(clip.id) ?? null;
      await atomicOutput(f.audio, (part) =>
        ffmpeg(audioPieceArgs(wav, layout, sampleRange(seg, fps), fadeMs, part), { signal: opts.signal, log }));
    }
    done++;
    opts.onProgress?.(done / total, `Encoded ${done}/${total} ${label} segments`);
  }, opts.signal);

  return {
    profile,
    files,
    encoded: total,
    reused: files.length - total,
    frames: timeline.segments.reduce((n, s) => n + s.frames, 0),
  };
}
