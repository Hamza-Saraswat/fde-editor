// Transcribe stage: run an ASR engine per clip (cached per engine+model, so switching engines never
// re-runs or re-bills), merge everything into ONE transcript.json with project-unique word ids, and
// attach detected silences and filler candidates.
import { loadEnvelope, type Envelope } from "../media/energy.ts";
import { refineFillerTokens } from "./refine.ts";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { projectPaths, type ProjectPaths } from "../core/paths.ts";
import {
  ScriptDocSchema, TranscriptSchema,
  type Clip, type Config, type ScriptDoc, type Span, type Transcript, type Word,
} from "../core/schema.ts";
import { loadConfig, loadProject, readJsonIfExists, writeJson } from "../core/store.ts";
import { prepareClip } from "../media/prepare.ts";
import { DEFAULT_MIN_SILENCE, detectSilences, type SilenceSpan } from "../media/silence.ts";
import { findFillerCandidates } from "./fillers.ts";
import { localTranscriber } from "./local.ts";
import { openaiTranscriber } from "./openai.ts";

/** One word as an engine returns it, clip-relative seconds. */
export type RawWord = { text: string; start: number; end: number };

export type TranscribeContext = {
  paths: ProjectPaths;
  script: ScriptDoc | null; // for vocabulary prompts
  silences: SilenceSpan[]; // this clip's silences (clip-relative), e.g. for choosing chunk boundaries
  signal?: AbortSignal;
  log?: string; // file to append child-process output to
  /** Progress within this clip; fraction 0–1, or undefined to keep the last value. */
  onProgress?: (msg: string, fraction?: number) => void;
  fetch?: typeof fetch; // override for tests
};

export type EngineKey = "local-whisper" | "local-parakeet" | "openai";

/** Interchangeable ASR engine. */
export type Transcriber = {
  name: string; // cache-file prefix: `${engineKey}-${model}`, e.g. local-whisper-medium.en, openai-whisper-1
  engineKey: EngineKey | (string & {}); // stored as transcript.engine
  model: string; // stored as transcript.model
  input: "wav16k" | "mp3"; // which derived audio file it reads (paths.asrWav / paths.asrMp3)
  /** Cheap checks that should fail before any work (e.g. a missing API key). */
  preflight?(): void;
  transcribe(clip: Clip, ctx: TranscribeContext): Promise<RawWord[]>;
};

export type LocalEngine = Config["transcription"]["localEngine"];
export type LocalModel = Config["transcription"]["localModel"];

export type TranscribeOptions = {
  engine?: Config["transcription"]["engine"];
  localEngine?: LocalEngine;
  localModel?: LocalModel;
  signal?: AbortSignal;
  /** Overall progress; fraction 0–1 across all clips. */
  onProgress?(msg: string, fraction: number): void;
  /** Ignore cached raw words and run the engine again. */
  force?: boolean;
  /** Use this engine instead of the configured one (tests, custom engines). */
  transcriber?: Transcriber;
};

export const RawWordSchema = z.object({ text: z.string(), start: z.number(), end: z.number() });

export const RawCacheSchema = z.object({
  engine: z.string(),
  model: z.string(),
  clipId: z.string(),
  createdAt: z.string(),
  words: z.array(RawWordSchema),
});

const SilenceCacheSchema = z.object({
  source: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  minDuration: z.number(),
  spans: z.array(z.object({ start: z.number(), end: z.number() })),
});

export function makeTranscriber(engine: "local" | "openai", localEngine: LocalEngine, localModel: LocalModel): Transcriber {
  return engine === "openai" ? openaiTranscriber() : localTranscriber({ engine: localEngine, model: localModel });
}

export const rawCachePath = (paths: ProjectPaths, transcriber: Pick<Transcriber, "name">, clipId: string) =>
  join(paths.transcriptsDir, `${transcriber.name}-${clipId}.json`);

export const silenceCachePath = (paths: ProjectPaths, clipId: string) => join(paths.transcriptsDir, `silences-${clipId}.json`);

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Merge per-clip raw words into transcript words: trimmed text, empties and non-finite times dropped,
 * times clamped (start ≥ 0, end ≥ start), sorted by start within each clip, ids w0, w1, … in clip
 * order then time order.
 */
export function mergeClipWords(perClip: { clipId: string; words: RawWord[] }[]): Word[] {
  const out: Word[] = [];
  for (const { clipId, words } of perClip) {
    const clean = words
      .map((w) => ({ text: String(w.text ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
      .filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => {
        const start = round3(Math.max(0, w.start));
        return { text: w.text, start, end: Math.max(start, round3(w.end)) };
      })
      .sort((a, b) => a.start - b.start); // stable: ties keep engine order
    for (const w of clean) out.push({ id: `w${out.length}`, clipId, ...w });
  }
  return out;
}

async function readRawCache(file: string): Promise<RawWord[] | null> {
  try {
    const cached = await readJsonIfExists(file, RawCacheSchema);
    return cached?.words ?? null;
  } catch {
    return null; // corrupt cache: re-run
  }
}

/** Silences for one clip, cached in transcripts/silences-<clipId>.json keyed by the source file's size+mtime. */
export async function clipSilences(clip: Clip, paths: ProjectPaths, opts: { signal?: AbortSignal; log?: string } = {}): Promise<SilenceSpan[]> {
  const source = [paths.wav(clip.id), paths.asrWav(clip.id), clip.path].find((p) => existsSync(p));
  if (!source) throw new Error(`No audio for ${clip.id}: ${paths.wav(clip.id)} is missing and ${clip.path} is gone`);
  const st = await stat(source);
  const cacheFile = silenceCachePath(paths, clip.id);
  const cached = await readJsonIfExists(cacheFile, SilenceCacheSchema).catch(() => null);
  if (cached && cached.source === source && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.minDuration === DEFAULT_MIN_SILENCE) {
    return cached.spans;
  }
  const spans = (await detectSilences(source, { signal: opts.signal, log: opts.log, minDuration: DEFAULT_MIN_SILENCE }))
    .map((s) => ({ start: round3(s.start), end: round3(s.end) }));
  await writeJson(cacheFile, SilenceCacheSchema, { source, size: st.size, mtimeMs: st.mtimeMs, minDuration: DEFAULT_MIN_SILENCE, spans });
  return spans;
}

/**
 * Make sure the derived ASR audio exists. The import stage normally made it; if not (or it was
 * deleted), rebuild just that file from the original recording with the import stage's own prepareClip.
 */
export async function ensureAsrAudio(slug: string, clip: Clip, input: Transcriber["input"], opts: { signal?: AbortSignal; log?: string } = {}): Promise<string> {
  const paths = projectPaths(slug);
  const target = input === "mp3" ? paths.asrMp3(clip.id) : paths.asrWav(clip.id);
  if (existsSync(target)) return target;
  await prepareClip(slug, clip, { only: [input === "mp3" ? "asrMp3" : "asrWav"], signal: opts.signal, log: opts.log });
  return target;
}

export async function transcribeProject(slug: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const paths = projectPaths(slug);
  const config = await loadConfig();
  const project = await loadProject(slug);
  const script = await readJsonIfExists(paths.script, ScriptDocSchema).catch(() => null);
  const tc = config.transcription;
  const transcriber = opts.transcriber
    ?? makeTranscriber(opts.engine ?? tc.engine, opts.localEngine ?? tc.localEngine, opts.localModel ?? tc.localModel);
  if (project.clips.length === 0) throw new Error("This project has no clips yet — import a recording first");

  await mkdir(paths.transcriptsDir, { recursive: true });
  const log = join(paths.runsDir, "transcribe.log");
  const signal = opts.signal;
  const report = (msg: string, f: number) => opts.onProgress?.(msg, Math.min(1, Math.max(0, f)));

  // fail fast (e.g. no API key) before spending minutes on silence detection
  const needsEngine = project.clips.some((c) => c.hasAudio && (opts.force || !existsSync(rawCachePath(paths, transcriber, c.id))));
  if (needsEngine) transcriber.preflight?.();

  const weights = project.clips.map((c) => (c.hasAudio ? Math.max(c.duration, 1) : 0));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let doneWeight = 0;

  const perClip: { clipId: string; words: RawWord[] }[] = [];
  const silences: Span[] = [];
  for (const [i, clip] of project.clips.entries()) {
    signal?.throwIfAborted();
    const weight = weights[i]!;
    const at = (f: number) => (doneWeight + weight * f) / totalWeight;
    if (!clip.hasAudio) {
      perClip.push({ clipId: clip.id, words: [] });
      continue;
    }

    report(`${clip.id}: finding silences`, at(0));
    const spans = await clipSilences(clip, paths, { signal, log });
    for (const s of spans) silences.push({ clipId: clip.id, start: s.start, end: s.end });

    const cacheFile = rawCachePath(paths, transcriber, clip.id);
    let words = opts.force ? null : await readRawCache(cacheFile);
    if (words) {
      report(`${clip.id}: reusing ${transcriber.name} transcript`, at(1));
    } else {
      await ensureAsrAudio(slug, clip, transcriber.input, { signal, log });
      let last = 0;
      report(`${clip.id}: transcribing with ${transcriber.name}`, at(0.05));
      words = await transcriber.transcribe(clip, {
        paths, script, silences: spans, signal, log,
        onProgress: (msg, f) => {
          if (f !== undefined && Number.isFinite(f)) last = Math.min(1, Math.max(0, f));
          report(`${clip.id}: ${msg}`, at(0.05 + 0.95 * last));
        },
      });
      await writeJson(cacheFile, RawCacheSchema, {
        engine: transcriber.engineKey, model: transcriber.model, clipId: clip.id, createdAt: new Date().toISOString(), words,
      });
    }
    perClip.push({ clipId: clip.id, words });
    doneWeight += weight;
  }

  const merged = mergeClipWords(perClip);
  // Filler stamps from ASR are coarse; snap each filler word (and its neighbours) to the quiet valleys
  // in the audio so cutting it takes the whole "uh" and nothing else.
  const envelopes = new Map<string, Envelope>();
  for (const clip of project.clips) {
    const wav = [paths.asrWav(clip.id), paths.wav(clip.id)].find((f) => existsSync(f));
    if (wav) envelopes.set(clip.id, await loadEnvelope(wav));
  }
  const { words, fillers } = refineFillerTokens(merged, findFillerCandidates(merged, silences, config), envelopes);
  const transcript = await writeJson(paths.transcript, TranscriptSchema, {
    engine: transcriber.engineKey, model: transcriber.model, words, silences, fillers,
  });
  report(`${words.length} words, ${fillers.length} filler candidates`, 1);
  return transcript;
}
