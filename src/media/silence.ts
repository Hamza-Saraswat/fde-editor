// Silence detection with an adaptive threshold.
// Pass 1: ffmpeg loudnorm measures the file; its "input_thresh" (the gating threshold for integrated
// loudness, ~10 LU under the speech level) is a good line between speech and room tone.
// Pass 2: ffmpeg silencedetect with that threshold. Both passes print to stderr at the default "info"
// level, so they call run() directly instead of the ffmpeg() helper (which forces -v error).
import { run, type RunOptions } from "../core/proc.ts";

export type SilenceSpan = { start: number; end: number };

export type DetectSilencesOptions = {
  /** Minimum silence length in seconds (silencedetect d=). Default 0.18. */
  minDuration?: number;
  /** Fixed threshold in dB; skips the loudnorm pass. */
  thresholdDb?: number;
  signal?: AbortSignal;
  log?: string;
};

export const THRESHOLD_MIN_DB = -60;
export const THRESHOLD_MAX_DB = -25;
export const DEFAULT_THRESHOLD_DB = -40; // used when loudnorm can't measure (e.g. a fully silent file)
export const DEFAULT_MIN_SILENCE = 0.18;

/** Read loudnorm's `input_thresh` (dB) from ffmpeg stderr. Null when missing or not finite ("-inf"). */
export function parseLoudnormThreshold(stderr: string): number | null {
  const matches = [...stderr.matchAll(/"input_thresh"\s*:\s*"([^"]*)"/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a measured threshold into the range where silencedetect behaves sensibly for speech. */
export function clampThreshold(db: number | null): number {
  if (db === null || !Number.isFinite(db)) return DEFAULT_THRESHOLD_DB;
  return Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, db));
}

/** Read the input duration ("Duration: 00:01:02.34") from ffmpeg stderr, in seconds. */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Parse silencedetect's `silence_start: x` / `silence_end: y` lines. A trailing silence_start with no
 * matching end (older ffmpeg builds don't flush one at EOF) runs until `duration` — taken from the
 * argument, else from the "Duration:" line in the same stderr; dropped if neither is known.
 */
export function parseSilencedetect(stderr: string, duration?: number): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+(?:e[-+]?\d+)?)/g)) {
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === "start") {
      open = Math.max(0, t);
    } else if (open !== null) {
      if (t > open) spans.push({ start: open, end: t });
      open = null;
    }
  }
  if (open !== null) {
    const end = duration ?? parseFfmpegDuration(stderr);
    if (end !== null && end !== undefined && end > open) spans.push({ start: open, end });
  }
  return spans;
}

/** Measure the file's loudness gate (dB) with ffmpeg loudnorm. Null if it can't be measured. */
export async function measureThreshold(file: string, opts: Pick<RunOptions, "signal" | "log"> = {}): Promise<number | null> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], opts);
  return parseLoudnormThreshold(stderr);
}

/** Silences in `wavPath` (seconds, file-relative), sorted, non-overlapping. */
export async function detectSilences(wavPath: string, opts: DetectSilencesOptions = {}): Promise<SilenceSpan[]> {
  const runOpts = { signal: opts.signal, log: opts.log };
  const threshold = opts.thresholdDb ?? clampThreshold(await measureThreshold(wavPath, runOpts));
  const d = opts.minDuration ?? DEFAULT_MIN_SILENCE;
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", wavPath, "-vn", "-af", `silencedetect=noise=${threshold.toFixed(2)}dB:d=${d}`, "-f", "null", "-"],
    runOpts,
  );
  return parseSilencedetect(stderr);
}
