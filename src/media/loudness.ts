// Two-pass EBU R128 loudness normalization (port of BLAI render-shorts assemble.py):
// pass 1 measures with loudnorm print_format=json, pass 2 applies with the measured_* values and
// linear=true, which is a single constant gain whenever the true-peak budget allows it.
import { run, type RunOptions } from "../core/proc.ts";
import type { Config } from "../core/schema.ts";

export type LoudnessTargets = Config["loudness"]; // { I, TP, LRA }

export type LoudnessMeasurement = {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
};

const num = (x: number) => String(Math.round(x * 100) / 100);

/** Pure: loudnorm filter string. Without measurements it is the measuring (pass 1) filter. */
export function loudnormFilter(t: LoudnessTargets, measured?: LoudnessMeasurement | null): string {
  const base = `loudnorm=I=${num(t.I)}:TP=${num(t.TP)}:LRA=${num(t.LRA)}`;
  if (!measured) return `${base}:print_format=json`;
  const m = measured;
  if (![m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].every(Number.isFinite)) {
    return base; // silence (-inf) can't be measured; single-pass loudnorm leaves it alone
  }
  return `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
}

/** Pure: pull loudnorm's JSON block out of ffmpeg's stderr. */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks?.length) throw new Error("loudnorm printed no measurement");
  const raw = JSON.parse(blocks[blocks.length - 1]!) as Record<string, string>;
  const f = (k: string) => {
    const v = raw[k];
    if (v === undefined) throw new Error(`loudnorm measurement missing ${k}`);
    return v === "-inf" ? Number.NEGATIVE_INFINITY : v === "inf" ? Number.POSITIVE_INFINITY : Number(v);
  };
  return {
    input_i: f("input_i"),
    input_tp: f("input_tp"),
    input_lra: f("input_lra"),
    input_thresh: f("input_thresh"),
    target_offset: f("target_offset"),
  };
}

/** Pass 1: measure the integrated loudness / true peak / LRA of a file's first audio stream. */
export async function measureLoudness(input: string, targets: LoudnessTargets, opts: Pick<RunOptions, "signal" | "log"> = {}): Promise<LoudnessMeasurement> {
  // loudnorm prints its JSON at info level, so this can't use the quiet ffmpeg() helper
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", input, "-map", "0:a:0", "-af", loudnormFilter(targets), "-f", "null", "-"], opts);
  return parseLoudnormJson(stderr);
}
