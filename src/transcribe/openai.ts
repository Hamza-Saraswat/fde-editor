// OpenAI whisper-1 over plain fetch + FormData (no SDK). Word + segment timestamps via verbose_json.
// The prompt starts with a filler-laden sentence (it nudges whisper-1 to keep "um"/"uh" instead of
// cleaning them up) followed by proper nouns harvested from the script. Files over the upload limit are
// split at silences near 20-minute boundaries and each chunk is prompted with the previous chunk's tail.
import { openAsBlob } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { ffmpeg } from "../core/proc.ts";
import type { Clip, ScriptDoc } from "../core/schema.ts";
import { writeJson } from "../core/store.ts";
import type { SilenceSpan } from "../media/silence.ts";
import type { RawWord, TranscribeContext, Transcriber } from "./index.ts";

export const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_MODEL = "whisper-1";
export const FILLER_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, so, um, yeah.";
export const PROMPT_MAX_CHARS = 800; // ≈ 200 tokens; whisper-1 only reads the last 224
export const PREVIOUS_TEXT_CHARS = 200;
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // the API limit is 25 MB
export const CHUNK_TARGET_SEC = 20 * 60;
export const MISSING_KEY_MESSAGE = "OPENAI_API_KEY is not set — add it to fde-editor/.env or use the local engine";

// ---------- response ----------

export const VerboseJsonSchema = z.object({
  text: z.string().default(""),
  language: z.string().optional(),
  duration: z.number().optional(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).default([]),
  segments: z.array(z.unknown()).optional(),
});
export type VerboseJson = z.infer<typeof VerboseJsonSchema>;

/** Raw words from a verbose_json response, shifted by `offset` seconds. */
export function parseVerboseJson(json: unknown, offset = 0): RawWord[] {
  return VerboseJsonSchema.parse(json).words.map((w) => ({ text: w.word, start: w.start + offset, end: w.end + offset }));
}

// ---------- prompt ----------

// capitalized only because they open a quoted title ("The Rise of the AI Engineer") or are "I"
const SKIP_TERMS = /^(i|i['’](m|ve|ll|d)|ok|okay|the|a|an|and|or|but|so|of|in|on|to|for|with|at|by|from|it|is|this|that)$/i;

/**
 * Proper nouns and rare terms from the script's spoken sentences, most frequent first: words with a
 * capital after the first letter (LinkedIn, OpenAI, RAG), capitalized words not at the start of a
 * sentence (Claude, Hamza), and letter+digit or dotted terms (GPT-4o, H100, Node.js).
 */
export function harvestTerms(script: Pick<ScriptDoc, "sentences"> | null): string[] {
  if (!script) return [];
  const seen = new Map<string, { term: string; count: number; first: number }>();
  let order = 0;
  for (const sentence of script.sentences) {
    sentence.text.split(/\s+/).forEach((raw, idx) => {
      const t = raw
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") // surrounding punctuation and quotes
        .replace(/['’]s$/u, ""); // possessive
      if (t.length < 2 || SKIP_TERMS.test(t) || /[/@:]/.test(t) || !/\p{L}/u.test(t)) return;
      const innerCap = /\p{Lu}/u.test(t.slice(1));
      const midCap = idx > 0 && /^\p{Lu}/u.test(t) && !/[.!?]["”’)]*$/u.test(sentence.text.split(/\s+/)[idx - 1] ?? "");
      const digits = /\p{N}/u.test(t);
      const dotted = /\p{L}\.\p{L}/u.test(t);
      if (!(innerCap || midCap || digits || dotted)) return;
      const key = t.toLowerCase();
      const hit = seen.get(key);
      if (hit) hit.count++;
      else seen.set(key, { term: t, count: 1, first: order++ });
    });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((x) => x.term);
}

/** The last ~`n` characters of `text`, starting on a word boundary. */
export function textTail(text: string, n = PREVIOUS_TEXT_CHARS): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  const space = cut.indexOf(" ");
  return (space >= 0 ? cut.slice(space + 1) : cut).trim();
}

/** Filler sentence + as many terms as fit + the previous chunk's tail, at most PROMPT_MAX_CHARS. */
export function buildPrompt(terms: string[], previousText = ""): string {
  const prev = previousText ? textTail(previousText) : "";
  let budget = PROMPT_MAX_CHARS - FILLER_PROMPT.length - (prev ? prev.length + 1 : 0) - 2; // spaces + final "."
  const picked: string[] = [];
  for (const term of terms) {
    const cost = term.length + (picked.length ? 2 : 0);
    if (cost > budget) continue;
    picked.push(term);
    budget -= cost;
  }
  return [FILLER_PROMPT, picked.length ? `${picked.join(", ")}.` : "", prev].filter(Boolean).join(" ").slice(0, PROMPT_MAX_CHARS);
}

// ---------- chunking ----------

export type Chunk = { start: number; end: number };

/**
 * Split [0, duration] into chunks of about `targetSec`, cutting in the middle of a silence near each
 * boundary (preferring pauses ≥ 0.4 s, nearest to the boundary, within ±windowSec). Falls back to a
 * hard cut at the boundary when there is no silence nearby.
 */
export function planChunks(duration: number, silences: SilenceSpan[], targetSec = CHUNK_TARGET_SEC, windowSec = 120): Chunk[] {
  const chunks: Chunk[] = [];
  const minLast = Math.min(60, targetSec / 4); // don't leave a tiny last chunk
  const window = Math.min(windowSec, targetSec / 3);
  let start = 0;
  while (duration - start > targetSec + minLast) {
    const target = start + targetSec;
    const near = silences
      .map((s) => ({ mid: (s.start + s.end) / 2, len: s.end - s.start }))
      .filter((s) => Math.abs(s.mid - target) <= window && s.mid > start + minLast && s.mid < duration - minLast);
    const long = near.filter((s) => s.len >= 0.4);
    const pool = long.length ? long : near;
    pool.sort((a, b) => Math.abs(a.mid - target) - Math.abs(b.mid - target) || b.len - a.len);
    const cut = pool[0]?.mid ?? target;
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: duration });
  return chunks;
}

// ---------- request ----------

export type RequestOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  retryDelayMs?: number; // base backoff before the single retry (default 2 s; Retry-After wins, capped at 30 s)
};

/** Never let the key (or any sk-… token the API echoes back) reach an error message or log. */
function scrub(text: string, apiKey: string): string {
  let t = apiKey ? text.split(apiKey).join("[redacted]") : text;
  t = t.replace(/sk-[A-Za-z0-9_*\-]{4,}/g, "sk-[redacted]");
  return t;
}

function apiErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof j.error?.message === "string") return j.error.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** POST one audio file. Retries once on 429 / 5xx / network error. Returns the parsed JSON body. */
export async function requestTranscription(file: string, prompt: string, opts: RequestOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseDelay = opts.retryDelayMs ?? 2000;
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append("file", await openAsBlob(file, { type: "audio/mpeg" }), basename(file));
    form.append("model", OPENAI_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    form.append("language", "en");
    form.append("prompt", prompt);

    let res: Response;
    try {
      res = await doFetch(OPENAI_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt === 0) {
        await sleep(baseDelay, opts.signal);
        continue;
      }
      throw new Error(`OpenAI transcription request failed: ${scrub(err instanceof Error ? err.message : String(err), opts.apiKey)}`);
    }

    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : baseDelay, opts.signal);
      continue;
    }
    throw new Error(`OpenAI transcription failed (HTTP ${res.status}): ${scrub(apiErrorMessage(body), opts.apiKey)}`);
  }
}

export function readApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error(MISSING_KEY_MESSAGE);
  return key;
}

// ---------- engine ----------

export type OpenAITranscriberOptions = {
  maxBytes?: number; // split files larger than this (default 24 MB)
  chunkSec?: number; // target chunk length (default 20 min)
  retryDelayMs?: number;
};

export function openaiTranscriber(opts: OpenAITranscriberOptions = {}): Transcriber {
  const name = `openai-${OPENAI_MODEL}`;
  return {
    name,
    engineKey: "openai",
    model: OPENAI_MODEL,
    input: "mp3",
    preflight: () => void readApiKey(),
    async transcribe(clip: Clip, ctx: TranscribeContext): Promise<RawWord[]> {
      const apiKey = readApiKey();
      const mp3 = ctx.paths.asrMp3(clip.id);
      const terms = harvestTerms(ctx.script);
      const request = { apiKey, fetch: ctx.fetch, signal: ctx.signal, retryDelayMs: opts.retryDelayMs };
      const rawFile = (suffix: string) => join(ctx.paths.transcriptsDir, `${name}-${clip.id}.api${suffix}.json`);
      await mkdir(ctx.paths.transcriptsDir, { recursive: true });

      const size = (await stat(mp3)).size;
      const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
      if (size <= maxBytes) {
        ctx.onProgress?.("uploading to OpenAI whisper-1", 0);
        const json = await requestTranscription(mp3, buildPrompt(terms), request);
        await writeJson(rawFile(""), z.unknown(), json);
        const words = parseVerboseJson(json);
        ctx.onProgress?.(`${words.length} words`, 1);
        return words;
      }

      // too big for one upload: ~20-minute chunks (shorter if the mp3 has an unusually high bitrate)
      const duration = clip.duration;
      const bytesPerSec = size / Math.max(duration, 1);
      const targetSec = Math.min(opts.chunkSec ?? CHUNK_TARGET_SEC, Math.max(30, (maxBytes * 0.8) / bytesPerSec));
      const chunks = planChunks(duration, ctx.silences, targetSec);
      const workDir = join(ctx.paths.transcriptsDir, `.tmp-${name}-${clip.id}`);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      try {
        const words: RawWord[] = [];
        let previousText = "";
        for (const [i, chunk] of chunks.entries()) {
          ctx.signal?.throwIfAborted();
          ctx.onProgress?.(`uploading part ${i + 1}/${chunks.length} to OpenAI whisper-1`, i / chunks.length);
          const part = join(workDir, `part${i + 1}.mp3`);
          await ffmpeg(
            ["-ss", chunk.start.toFixed(3), "-i", mp3, "-t", (chunk.end - chunk.start).toFixed(3), "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", part],
            { signal: ctx.signal, log: ctx.log },
          );
          const json = await requestTranscription(part, buildPrompt(terms, previousText), request);
          await writeJson(rawFile(`.part${i + 1}`), z.unknown(), json);
          words.push(...parseVerboseJson(json, chunk.start));
          previousText = VerboseJsonSchema.parse(json).text;
        }
        ctx.onProgress?.(`${words.length} words from ${chunks.length} parts`, 1);
        return words;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
