// Local ASR through the pinned HyperFrames CLI (whisper.cpp or Parakeet). No network, no key.
//   hyperframes transcribe <16k mono wav> -d <outDir> --json --engine whisper --model medium.en --language en
// writes <outDir>/transcript.json = [{ id?, text, start, end }] in seconds (see spikes/transcribe-bakeoff.sh).
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HYPERFRAMES_BIN } from "../core/paths.ts";
import { run } from "../core/proc.ts";
import type { Clip } from "../core/schema.ts";
import type { LocalEngine, LocalModel, RawWord, TranscribeContext, Transcriber } from "./index.ts";

const HyperframesWordSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

/** Parse HyperFrames' transcript.json (a flat word array; `{ words: [...] }` is accepted too). */
export function parseHyperframesTranscript(json: unknown): RawWord[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { words?: unknown }).words)
      ? (json as { words: unknown[] }).words
      : null;
  if (!list) throw new Error("HyperFrames transcript.json is not a word array");
  return z.array(HyperframesWordSchema).parse(list).map(({ text, start, end }) => ({ text, start, end }));
}

// ms of whisper.cpp time allowed per second of audio. Generous: the spike ran medium.en at ~0.3× real
// time on Apple silicon, but slow CPUs can be 10× worse and large-v3 is ~3× medium.
const MS_PER_AUDIO_SECOND: Record<LocalModel, number> = {
  "tiny.en": 1500,
  "base.en": 2000,
  "small.en": 3000,
  "medium.en": 4000,
  "large-v3": 8000,
};

/** --timeout for the whisper engine, scaled by clip length (minimum 2 minutes). */
export function whisperTimeoutMs(model: LocalModel, durationSec: number): number {
  const perSecond = MS_PER_AUDIO_SECOND[model] ?? 4000;
  return Math.round(Math.max(120_000, (Number.isFinite(durationSec) ? durationSec : 0) * perSecond));
}

/** CLI arguments for one clip. Parakeet takes no --model / --timeout. */
export function hyperframesArgs(input: string, outDir: string, engine: LocalEngine, model: LocalModel, durationSec: number): string[] {
  const args = ["transcribe", input, "-d", outDir, "--json", "--engine", engine];
  if (engine === "whisper") args.push("--model", model, "--timeout", String(whisperTimeoutMs(model, durationSec)));
  args.push("--language", "en");
  return args;
}

export type LocalTranscriberOptions = { engine: LocalEngine; model: LocalModel; bin?: string };

/** Run HyperFrames on one 16 kHz mono wav and return its raw words. */
export async function transcribeLocalFile(
  wavPath: string,
  workDir: string,
  opts: LocalTranscriberOptions & { durationSec: number; signal?: AbortSignal; log?: string; onProgress?: TranscribeContext["onProgress"] },
): Promise<RawWord[]> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  try {
    const { stdout } = await run(opts.bin ?? HYPERFRAMES_BIN, hyperframesArgs(wavPath, workDir, opts.engine, opts.model, opts.durationSec), {
      signal: opts.signal,
      log: opts.log,
      onStderrLine: (line) => {
        const msg = line.replace(/\u001b\[[0-9;]*m/g, "").trim(); // strip ANSI colours
        if (msg) opts.onProgress?.(msg.slice(0, 160));
      },
    });
    let transcriptPath = join(workDir, "transcript.json");
    const summary = parseSummary(stdout);
    if (summary?.ok === false) throw new Error(`hyperframes transcribe failed: ${summary.error ?? stdout.slice(-400)}`);
    if (!existsSync(transcriptPath) && summary?.transcriptPath && existsSync(summary.transcriptPath)) transcriptPath = summary.transcriptPath;
    if (!existsSync(transcriptPath)) throw new Error(`hyperframes transcribe wrote no transcript.json (stdout: ${stdout.slice(-400)})`);
    return parseHyperframesTranscript(JSON.parse(await readFile(transcriptPath, "utf8")));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

type Summary = { ok?: boolean; error?: string; transcriptPath?: string };

function parseSummary(stdout: string): Summary | null {
  // --json prints one JSON object; tolerate log lines before it
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const v = JSON.parse(stdout.slice(start)) as unknown;
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    return {
      ok: typeof o.ok === "boolean" ? o.ok : undefined,
      error: typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : undefined,
      transcriptPath: typeof o.transcriptPath === "string" ? o.transcriptPath : undefined,
    };
  } catch {
    return null;
  }
}

export function localTranscriber(opts: LocalTranscriberOptions): Transcriber {
  const model = opts.engine === "parakeet" ? "default" : opts.model;
  const engineKey = opts.engine === "parakeet" ? "local-parakeet" : "local-whisper";
  const name = `${engineKey}-${model}`;
  return {
    name,
    engineKey,
    model,
    input: "wav16k",
    async transcribe(clip: Clip, ctx: TranscribeContext) {
      const workDir = join(ctx.paths.transcriptsDir, `.tmp-${name}-${clip.id}`);
      ctx.onProgress?.(`local ${opts.engine}${opts.engine === "whisper" ? ` ${opts.model}` : ""} (first run downloads the model)`, 0);
      const words = await transcribeLocalFile(ctx.paths.asrWav(clip.id), workDir, {
        ...opts, durationSec: clip.duration, signal: ctx.signal, log: ctx.log, onProgress: ctx.onProgress,
      });
      ctx.onProgress?.(`${words.length} words`, 1);
      return words;
    },
  };
}
