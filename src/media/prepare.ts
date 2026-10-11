// Import-time media prep for one clip, in a single decode pass:
//   proxy/<id>.mp4     720p CFR H.264 for the browser player (keyframe every second, faststart)
//   audio/<id>.wav     48 kHz stereo PCM, the render source (sample-accurate cutting)
//   audio/<id>.16k.wav 16 kHz mono PCM for local ASR
//   audio/<id>.mp3     64 kbps mono for the OpenAI transcription API
// Outputs that already exist and are newer than the source are skipped.
import { existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ffmpeg } from "../core/proc.ts";
import { projectPaths } from "../core/paths.ts";
import { loadConfig } from "../core/store.ts";
import type { Clip, Config } from "../core/schema.ts";

/** fraction 0–1 plus a short human message; maps straight onto StageStatus.progress/message. */
export type Progress = (fraction: number, message: string) => void;

export type MediaOptions = {
  signal?: AbortSignal;
  onProgress?: Progress;
  log?: string; // file that every ffmpeg command line + stderr tail is appended to
  config?: Config; // defaults to fde-editor.config.json
};

export const SAMPLE_RATE = 48_000;

/** True when `out` exists and was written after `src` last changed. */
export function isFresh(out: string, src: string): boolean {
  if (!existsSync(out)) return false;
  return statSync(out).mtimeMs >= statSync(src).mtimeMs;
}

/** a/b/c1.wav -> a/b/c1.part.wav (same folder, so the final rename is atomic). */
export const partPath = (file: string) => file.replace(/(\.[^./]+)?$/, (ext) => `.part${ext}`);

/** Write via a .part file and rename on success, so a cancelled job never leaves a half file behind. */
export async function atomicOutput<T>(file: string, fn: (part: string) => Promise<T>): Promise<T> {
  const part = partPath(file);
  await mkdir(dirname(file), { recursive: true });
  try {
    const res = await fn(part);
    await rename(part, file);
    return res;
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

/** Line handler for `ffmpeg -progress pipe:1`: reports 0–1 of `totalSeconds`. */
export function progressReader(totalSeconds: number, cb?: (fraction: number) => void): (line: string) => void {
  return (line) => {
    // out_time_ms is (historically, and still) microseconds, same as out_time_us
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && cb && totalSeconds > 0) cb(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / totalSeconds)));
  };
}

export const hdrError = (clip: Pick<Clip, "name">) =>
  new Error(`${clip.name} is HDR (HLG/PQ). Record in SDR (turn HDR off in the camera or recorder settings) and import it again.`);

export type PrepareTarget = "proxy" | "wav" | "asrWav" | "asrMp3";
export type PreparedClip = Record<PrepareTarget, string> & { made: PrepareTarget[] };

/** The ffmpeg output options for each prepared file (pure; exported for tests). */
export function prepareOutputArgs(target: PrepareTarget, clip: Clip, fps: number, audioIn: string, out: string): string[] {
  const resample = (rate: number) => `aresample=${rate}:async=1:first_pts=0`; // sample 0 == video t=0, gaps filled
  switch (target) {
    case "proxy":
      return [
        "-map", "0:v:0",
        ...(clip.hasAudio ? ["-map", audioIn, "-af", resample(SAMPLE_RATE), "-ac", "2", "-c:a", "aac", "-b:a", "128k"] : ["-an"]),
        "-sn", "-dn",
        "-vf", "scale=-2:'min(720,trunc(ih/2)*2)',setsar=1,format=yuv420p",
        "-r", String(fps), "-fps_mode", "cfr",
        "-c:v", "h264_videotoolbox", "-q:v", "55", "-g", String(fps),
        "-movflags", "+faststart", "-f", "mp4", out,
      ];
    case "wav":
      return ["-map", audioIn, "-af", resample(SAMPLE_RATE), "-ac", "2", "-c:a", "pcm_s16le", "-f", "wav", out];
    case "asrWav":
      return ["-map", audioIn, "-af", resample(16_000), "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", out];
    case "asrMp3":
      return ["-map", audioIn, "-af", resample(16_000), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", out];
  }
}

export async function prepareClip(
  slug: string,
  clip: Clip,
  opts: MediaOptions & { only?: PrepareTarget[]; force?: boolean } = {},
): Promise<PreparedClip> {
  if (clip.hdr) throw hdrError(clip);
  if (!existsSync(clip.path)) throw new Error(`${clip.name}: source recording not found at ${clip.path}`);
  const config = opts.config ?? (await loadConfig());
  const fps = config.output.fps;
  const p = projectPaths(slug);
  const files: Record<PrepareTarget, string> = {
    proxy: p.proxy(clip.id),
    wav: p.wav(clip.id),
    asrWav: p.asrWav(clip.id),
    asrMp3: p.asrMp3(clip.id),
  };
  const wanted = opts.only ?? (["proxy", "wav", "asrWav", "asrMp3"] as PrepareTarget[]);
  const todo = wanted.filter((t) => opts.force || !isFresh(files[t], clip.path));
  if (!todo.length) {
    opts.onProgress?.(1, `${clip.name}: media up to date`);
    return { ...files, made: [] };
  }

  const args = ["-progress", "pipe:1", "-i", clip.path];
  const needsSilence = !clip.hasAudio && todo.some((t) => t !== "proxy");
  if (needsSilence) args.push("-f", "lavfi", "-t", clip.duration.toFixed(6), "-i", `anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
  const audioIn = clip.hasAudio ? "0:a:0" : "1:a:0";
  for (const t of todo) {
    await mkdir(dirname(files[t]), { recursive: true });
    args.push(...prepareOutputArgs(t, clip, fps, audioIn, partPath(files[t])));
  }

  const message = `Preparing ${clip.name}`;
  opts.onProgress?.(0, message);
  try {
    await ffmpeg(args, {
      signal: opts.signal,
      log: opts.log ?? join(p.runsDir, "prepare.log"),
      onStdoutLine: progressReader(clip.duration, (f) => opts.onProgress?.(f * 0.99, message)),
    });
    for (const t of todo) await rename(partPath(files[t]), files[t]);
  } catch (err) {
    await Promise.all(todo.map((t) => rm(partPath(files[t]), { force: true })));
    throw err;
  }
  opts.onProgress?.(1, `${clip.name}: media ready`);
  return { ...files, made: todo };
}
