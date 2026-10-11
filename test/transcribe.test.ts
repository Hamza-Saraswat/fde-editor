import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Point the project store at a temp folder before any src module reads FDE_PROJECTS_DIR.
const { projectsDir, prevProjectsDir } = vi.hoisted(() => {
  const prevProjectsDir = process.env.FDE_PROJECTS_DIR;
  const base = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const projectsDir = `${base}/fde-transcribe-test-${process.pid}-${Date.now()}`;
  process.env.FDE_PROJECTS_DIR = projectsDir;
  return { projectsDir, prevProjectsDir };
});

import { normalizeTranscriptWords } from "../src/core/normalize.ts";
import { projectPaths } from "../src/core/paths.ts";
import { ProjectSchema, TranscriptSchema, WordSchema, type Clip, type ScriptDoc } from "../src/core/schema.ts";
import { readJson, writeJson } from "../src/core/store.ts";
import {
  clampThreshold, detectSilences, parseFfmpegDuration, parseLoudnormThreshold, parseSilencedetect,
} from "../src/media/silence.ts";
import {
  mergeClipWords, rawCachePath, transcribeProject, type RawWord, type TranscribeContext, type Transcriber,
} from "../src/transcribe/index.ts";
import { hyperframesArgs, localTranscriber, parseHyperframesTranscript, whisperTimeoutMs } from "../src/transcribe/local.ts";
import {
  FILLER_PROMPT, MISSING_KEY_MESSAGE, PROMPT_MAX_CHARS, buildPrompt, harvestTerms, openaiTranscriber,
  parseVerboseJson, planChunks, requestTranscription,
} from "../src/transcribe/openai.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** tone 0–1 s, silence 1–1.5 s, tone 1.5–2.5 s, silence 2.5–3.1 s (48 kHz mono). */
function makeToneWav(file: string, ext: "wav" | "mp3" = "wav") {
  mkdirSync(join(file, ".."), { recursive: true });
  const codec = ext === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "64k"] : [];
  execFileSync("ffmpeg", [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=1:sample_rate=48000",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-filter_complex", "[1]atrim=duration=0.5[s];[0][s][0]concat=n=3:v=0:a=1,apad=pad_dur=0.6[out]",
    "-map", "[out]", "-ac", "1", ...codec, file,
  ]);
}

const TEST_KEY = "sk-test-not-a-real-key-0000"; // fake; fetch is always mocked

function clip(id: string, path: string, duration = 3.1): Clip {
  return { id, name: `${id}.mov`, path, duration, width: 1920, height: 1080, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeAll(() => mkdirSync(projectsDir, { recursive: true }));
afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  if (prevProjectsDir === undefined) delete process.env.FDE_PROJECTS_DIR;
  else process.env.FDE_PROJECTS_DIR = prevProjectsDir;
});
afterEach(() => vi.unstubAllEnvs());

// ---------- engine output → transcript words ----------

describe("engine fixtures", () => {
  it("HyperFrames and OpenAI raw output normalize to the same Transcript word shape", () => {
    const local = mergeClipWords([{ clipId: "c1", words: parseHyperframesTranscript(fixture("hyperframes-local.json")) }]);
    const openai = mergeClipWords([{ clipId: "c1", words: parseVerboseJson(fixture("openai-verbose.json")) }]);
    for (const words of [local, openai]) {
      expect(words.length).toBe(15);
      words.forEach((w, i) => {
        expect(Object.keys(w).sort()).toEqual(["clipId", "end", "id", "start", "text"]);
        expect(WordSchema.strict().parse(w)).toEqual(w);
        expect(w.id).toBe(`w${i}`);
        expect(w.end).toBeGreaterThanOrEqual(w.start);
      });
    }
    // same tokens for the aligner, timings within 50 ms
    expect(normalizeTranscriptWords(local).map((t) => t.token)).toEqual(normalizeTranscriptWords(openai).map((t) => t.token));
    local.forEach((w, i) => expect(Math.abs(w.start - openai[i]!.start)).toBeLessThan(0.05));
    // float noise from the API is rounded to ms
    expect(openai[1]!.start).toBe(0.44);
  });

  it("mergeClipWords trims, drops empties, clamps, sorts, and numbers across clips", () => {
    const words = mergeClipWords([
      { clipId: "c1", words: [{ text: " world ", start: 1, end: 1.4 }, { text: "hello", start: 0.2, end: 0.6 }, { text: "  ", start: 2, end: 2.1 }] },
      { clipId: "c2", words: [{ text: "again", start: 0.5, end: 0.3 }, { text: "bad", start: Number.NaN, end: 1 }, { text: "early", start: -0.2, end: 0.1 }] },
    ]);
    expect(words).toEqual([
      { id: "w0", clipId: "c1", text: "hello", start: 0.2, end: 0.6 },
      { id: "w1", clipId: "c1", text: "world", start: 1, end: 1.4 },
      { id: "w2", clipId: "c2", text: "early", start: 0, end: 0.1 },
      { id: "w3", clipId: "c2", text: "again", start: 0.5, end: 0.5 },
    ]);
  });
});

// ---------- silences ----------

describe("silence parsing", () => {
  const loudnorm = `[Parsed_loudnorm_0 @ 0x15bf0eaf0] \n{\n\t"input_i" : "-22.96",\n\t"input_tp" : "-18.06",\n\t"input_lra" : "0.50",\n\t"input_thresh" : "-33.32",\n\t"output_i" : "-23.19"\n}\n`;

  it("reads loudnorm's input_thresh and clamps it", () => {
    expect(parseLoudnormThreshold(loudnorm)).toBe(-33.32);
    expect(parseLoudnormThreshold(loudnorm.replace("-33.32", "-inf"))).toBeNull();
    expect(parseLoudnormThreshold("nothing here")).toBeNull();
    expect(clampThreshold(-33.32)).toBe(-33.32);
    expect(clampThreshold(-75)).toBe(-60);
    expect(clampThreshold(-12)).toBe(-25);
    expect(clampThreshold(null)).toBe(-40);
  });

  it("parses silencedetect pairs and a trailing open silence", () => {
    const stderr = [
      "  Duration: 00:00:03.10, bitrate: 768 kb/s",
      "[silencedetect @ 0x1] silence_start: 0.999875",
      "[silencedetect @ 0x1] silence_end: 1.500146 | silence_duration: 0.500271",
      "[silencedetect @ 0x1] silence_start: 2.499875",
    ].join("\n");
    expect(parseFfmpegDuration(stderr)).toBeCloseTo(3.1);
    expect(parseSilencedetect(stderr)).toEqual([{ start: 0.999875, end: 1.500146 }, { start: 2.499875, end: 3.1 }]);
    expect(parseSilencedetect(stderr, 2.8)).toEqual([{ start: 0.999875, end: 1.500146 }, { start: 2.499875, end: 2.8 }]);
    expect(parseSilencedetect("[silencedetect @ 0x1] silence_start: -0.01\n[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.41"))
      .toEqual([{ start: 0, end: 0.4 }]);
  });

  it.skipIf(!hasFfmpeg)("detects silences in a real file with the adaptive threshold", async () => {
    const wav = join(projectsDir, "media", "tone.wav");
    makeToneWav(wav);
    const spans = await detectSilences(wav);
    expect(spans.length).toBe(2);
    expect(spans[0]!.start).toBeCloseTo(1.0, 1);
    expect(spans[0]!.end).toBeCloseTo(1.5, 1);
    expect(spans[1]!.start).toBeCloseTo(2.5, 1);
    expect(spans[1]!.end).toBeCloseTo(3.1, 1);
  });
});

// ---------- local engine ----------

describe("local engine (HyperFrames CLI)", () => {
  it("builds whisper and parakeet command lines", () => {
    expect(hyperframesArgs("/a/c1.16k.wav", "/t", "whisper", "medium.en", 600)).toEqual([
      "transcribe", "/a/c1.16k.wav", "-d", "/t", "--json", "--engine", "whisper", "--model", "medium.en", "--timeout", "2400000", "--language", "en",
    ]);
    expect(hyperframesArgs("/a/c1.16k.wav", "/t", "parakeet", "medium.en", 600)).toEqual([
      "transcribe", "/a/c1.16k.wav", "-d", "/t", "--json", "--engine", "parakeet", "--language", "en",
    ]);
    expect(whisperTimeoutMs("medium.en", 10)).toBe(120_000);
    expect(whisperTimeoutMs("large-v3", 600)).toBe(4_800_000);
  });

  it("runs the CLI in a per-clip temp dir under transcripts/ and returns raw words", async () => {
    const paths = projectPaths("local-engine");
    const binDir = join(projectsDir, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "hyperframes");
    writeFileSync(bin, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${binDir}/args.txt"`,
      'dir=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-d" ]; then dir="$2"; shift; fi; shift; done',
      'printf \'%s\' \'[{"text":" Hello","start":0.1,"end":0.5,"id":"w0"},{"text":"world.","start":0.6,"end":1.0,"id":"w1"}]\' > "$dir/transcript.json"',
      'echo "{\\"ok\\":true,\\"transcriptPath\\":\\"$dir/transcript.json\\"}"',
    ].join("\n"));
    chmodSync(bin, 0o755);
    mkdirSync(paths.transcriptsDir, { recursive: true });

    const t = localTranscriber({ engine: "whisper", model: "small.en", bin });
    expect([t.name, t.engineKey, t.model, t.input]).toEqual(["local-whisper-small.en", "local-whisper", "small.en", "wav16k"]);
    const words = await t.transcribe(clip("c1", "/x.mov", 30), { paths, script: null, silences: [] });
    expect(words).toEqual([{ text: " Hello", start: 0.1, end: 0.5 }, { text: "world.", start: 0.6, end: 1.0 }]);
    const args = readFileSync(join(binDir, "args.txt"), "utf8").trim().split("\n");
    expect(args.slice(0, 2)).toEqual(["transcribe", paths.asrWav("c1")]);
    expect(args[3]!.startsWith(paths.transcriptsDir)).toBe(true);
    expect(args).toContain("--timeout");
    expect(await readdir(paths.transcriptsDir)).toEqual([]); // temp dir cleaned up

    expect(localTranscriber({ engine: "parakeet", model: "medium.en" }).name).toBe("local-parakeet-default");
  });
});

// ---------- OpenAI engine ----------

const SCRIPT: ScriptDoc = {
  title: "t",
  sections: [],
  cues: [],
  sentences: [
    "Search \"AI engineer\" on LinkedIn right now, and you'll find two jobs.",
    "You're not training GPT or Claude.",
    "Claude ships with Node.js examples, and GPT-4o costs $20 in 2023.",
    "I'm Hamza.",
    "The term took off when swyx wrote \"The Rise of the AI Engineer.\"",
  ].map((text, i) => ({ id: `s${i}`, sectionId: "sec0", blockId: "b0", text, tokens: [] })),
};

describe("OpenAI prompt", () => {
  it("harvests proper nouns and rare terms, most frequent first", () => {
    const terms = harvestTerms(SCRIPT);
    expect(terms[0]).toBe("AI"); // said twice; everything else once, in order of appearance
    expect(terms.slice(1, 4)).toEqual(["LinkedIn", "GPT", "Claude"]);
    expect(terms).toEqual(expect.arrayContaining(["Node.js", "GPT-4o", "Hamza", "Rise", "Engineer"]));
    for (const junk of ["Search", "You're", "I'm", "The", "$20", "2023", "20"]) expect(terms).not.toContain(junk);
    expect(harvestTerms(null)).toEqual([]);
  });

  it("puts the filler sentence first, caps the length, and appends the previous chunk's tail", () => {
    expect(buildPrompt([])).toBe(FILLER_PROMPT);
    expect(buildPrompt(["LinkedIn", "Claude"])).toBe(`${FILLER_PROMPT} LinkedIn, Claude.`);
    const many = Array.from({ length: 300 }, (_, i) => `Term${i}x`);
    const previous = "word ".repeat(300) + "the end of chunk one";
    const p = buildPrompt(many, previous);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(p.startsWith(FILLER_PROMPT)).toBe(true);
    expect(p.endsWith("the end of chunk one")).toBe(true);
    expect(p).toContain("Term0x, Term1x");
  });
});

describe("OpenAI chunk planning", () => {
  it("cuts inside silences nearest to each 20-minute boundary", () => {
    const silences = [
      { start: 1100, end: 1101 }, // too far from 1200
      { start: 1190, end: 1190.3 }, // short (< 0.4 s)
      { start: 1230, end: 1231 }, // long, 30.5 s from the boundary → chosen
      { start: 2420, end: 2421 }, // next boundary is 1230.5 + 1200 = 2430.5
    ];
    expect(planChunks(3000, silences)).toEqual([
      { start: 0, end: 1230.5 },
      { start: 1230.5, end: 2420.5 },
      { start: 2420.5, end: 3000 },
    ]);
  });

  it("hard-cuts at the boundary when there is no silence, and leaves no tiny last chunk", () => {
    expect(planChunks(2430, [])).toEqual([{ start: 0, end: 1200 }, { start: 1200, end: 2430 }]);
    expect(planChunks(1250, [])).toEqual([{ start: 0, end: 1250 }]);
  });
});

describe("OpenAI requests (fetch mocked)", () => {
  const verbose = fixture("openai-verbose.json");

  function setupMp3(slug: string, bytes = 2048) {
    const paths = projectPaths(slug);
    mkdirSync(paths.audioDir, { recursive: true });
    writeFileSync(paths.asrMp3("c1"), Buffer.alloc(bytes, 7));
    return paths;
  }

  it("throws a clear error when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const t = openaiTranscriber();
    expect(() => t.preflight!()).toThrow(MISSING_KEY_MESSAGE);
    const fetchSpy = vi.fn();
    await expect(t.transcribe(clip("c1", "/x"), { paths: setupMp3("no-key"), script: null, silences: [], fetch: fetchSpy }))
      .rejects.toThrow(MISSING_KEY_MESSAGE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts whisper-1 verbose_json with word+segment timestamps, a prompt, and saves the raw JSON", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    const paths = setupMp3("openai-single");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return jsonResponse(verbose);
    }) as typeof fetch;

    const ctx: TranscribeContext = { paths, script: SCRIPT, silences: [], fetch: fetchMock };
    const words = await openaiTranscriber().transcribe(clip("c1", "/x"), ctx);
    expect(words.length).toBe(15);
    expect(words[0]).toEqual({ text: "Search", start: 0, end: 0.4399999976158142 });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
    expect(form.get("language")).toBe("en");
    const prompt = form.get("prompt") as string;
    expect(prompt.startsWith(FILLER_PROMPT)).toBe(true);
    expect(prompt).toContain("LinkedIn");
    const file = form.get("file") as File;
    expect(file.size).toBe(2048);
    expect(file.name).toBe("c1.mp3");

    const raw = JSON.parse(readFileSync(join(paths.transcriptsDir, "openai-whisper-1-c1.api.json"), "utf8"));
    expect(raw).toEqual(verbose);
  });

  it("retries once on 429, then succeeds", async () => {
    const file = join(setupMp3("openai-retry").audioDir, "c1.mp3");
    let n = 0;
    const fetchMock = (async () => (++n === 1 ? jsonResponse({ error: { message: "rate limited" } }, 429) : jsonResponse(verbose))) as typeof fetch;
    const json = await requestTranscription(file, "p", { apiKey: TEST_KEY, fetch: fetchMock, retryDelayMs: 1 });
    expect(n).toBe(2);
    expect(parseVerboseJson(json).length).toBe(15);
  });

  it("gives up after one retry on 5xx and never leaks the key", async () => {
    const file = join(setupMp3("openai-5xx").audioDir, "c1.mp3");
    let n = 0;
    const fetchMock = (async () => {
      n++;
      return jsonResponse({ error: { message: `upstream broke for ${TEST_KEY}` } }, 503);
    }) as typeof fetch;
    const err = await requestTranscription(file, "p", { apiKey: TEST_KEY, fetch: fetchMock, retryDelayMs: 1 }).catch((e: Error) => e);
    expect(n).toBe(2);
    expect(String(err)).toContain("HTTP 503");
    expect(String(err)).not.toContain(TEST_KEY);
    expect(String(err)).not.toContain("not-a-real-key");
  });

  it("does not retry a 401 and redacts echoed keys", async () => {
    const file = join(setupMp3("openai-401").audioDir, "c1.mp3");
    let n = 0;
    const fetchMock = (async () => {
      n++;
      return jsonResponse({ error: { message: "Incorrect API key provided: sk-test-****0000." } }, 401);
    }) as typeof fetch;
    const err = await requestTranscription(file, "p", { apiKey: TEST_KEY, fetch: fetchMock, retryDelayMs: 1 }).catch((e: Error) => e);
    expect(n).toBe(1);
    expect(String(err)).toContain("HTTP 401");
    expect(String(err)).not.toMatch(/sk-test/);
  });

  it.skipIf(!hasFfmpeg)("splits a too-big file at silences, chains prompts, and offsets timestamps", async () => {
    vi.stubEnv("OPENAI_API_KEY", TEST_KEY);
    const paths = projectPaths("openai-chunks");
    // 0–2 tone, 2–3 silence, 3–5 tone, 5–6 silence, 6–9 tone
    mkdirSync(paths.audioDir, { recursive: true });
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=9:sample_rate=16000",
      "-af", "volume=enable='between(t,2,3)+between(t,5,6)':volume=0", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", paths.asrMp3("c1"),
    ]);
    const prompts: string[] = [];
    const sizes: number[] = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      prompts.push(form.get("prompt") as string);
      sizes.push((form.get("file") as File).size);
      const k = prompts.length;
      return jsonResponse({ text: `chunk ${k} text`, words: [{ word: `part${k}`, start: 0.5, end: 1.0 }], segments: [] });
    }) as typeof fetch;

    const t = openaiTranscriber({ maxBytes: 1000, chunkSec: 3, retryDelayMs: 1 });
    const words = await t.transcribe(clip("c1", "/x", 9), {
      paths, script: null, fetch: fetchMock, silences: [{ start: 2, end: 3 }, { start: 5, end: 6 }],
    });
    expect(words.map((w) => w.text)).toEqual(["part1", "part2", "part3"]);
    expect(words.map((w) => w.start)).toEqual([0.5, 3.0, 6.0]); // chunks [0,2.5] [2.5,5.5] [5.5,9]
    expect(prompts[0]).toBe(FILLER_PROMPT);
    expect(prompts[1]!.endsWith("chunk 1 text")).toBe(true);
    expect(prompts[2]!.endsWith("chunk 2 text")).toBe(true);
    expect(sizes.every((s) => s > 0)).toBe(true);
    const files = await readdir(paths.transcriptsDir);
    expect(files.sort()).toEqual(["openai-whisper-1-c1.api.part1.json", "openai-whisper-1-c1.api.part2.json", "openai-whisper-1-c1.api.part3.json"]);
  });
});

// ---------- the whole stage ----------

describe.skipIf(!hasFfmpeg)("transcribeProject", () => {
  const slug = "stage-test";
  const paths = projectPaths(slug);

  const fake = (words: RawWord[] | Error): Transcriber => ({
    name: "fake-test",
    engineKey: "fake",
    model: "test",
    input: "wav16k",
    async transcribe() {
      if (words instanceof Error) throw words;
      return words;
    },
  });

  beforeAll(async () => {
    const original = join(projectsDir, "media", "c1.wav");
    makeToneWav(original);
    mkdirSync(paths.audioDir, { recursive: true });
    copyFileSync(original, paths.wav("c1"));
    await writeJson(paths.project, ProjectSchema, {
      slug, title: "Stage test", createdAt: new Date().toISOString(), scriptSource: "", clips: [clip("c1", original)],
    });
  });

  it("merges words, finds silences and fillers, and caches the raw words", async () => {
    const progress: number[] = [];
    const t = await transcribeProject(slug, {
      transcriber: fake([
        { text: " Hello ", start: 0.1, end: 0.3 },
        { text: "there", start: 0.7, end: 0.9 }, // 0.4 s gap inside the tone: voiced → gap filler
        { text: "um", start: 0.92, end: 0.98 },
        { text: "", start: 1.2, end: 1.3 },
        { text: "world", start: 1.6, end: 2.4 },
        { text: "again", start: 2.45, end: 2.4 },
      ]),
      onProgress: (_msg, f) => progress.push(f),
    });

    expect(TranscriptSchema.parse(t)).toEqual(t);
    expect(await readJson(paths.transcript, TranscriptSchema)).toEqual(t);
    expect([t.engine, t.model]).toEqual(["fake", "test"]);
    expect(t.words.map((w) => [w.id, w.text])).toEqual([["w0", "Hello"], ["w1", "there"], ["w2", "um"], ["w3", "world"], ["w4", "again"]]);
    expect(t.words[4]!.end).toBe(2.45);

    expect(t.silences.length).toBe(2);
    expect(t.silences[0]!.clipId).toBe("c1");
    expect(t.silences[0]!.start).toBeCloseTo(1.0, 1);

    // gap "there"→"um" is 0.02 s (too short); "um"→"world" is mostly silent; "Hello"→"there" is voiced
    expect(t.fillers).toEqual([
      { id: "f0", clipId: "c1", start: 0.34, end: 0.66, kind: "gap", afterWordId: "w0" },
      { id: "f1", clipId: "c1", start: 0.92, end: 0.98, kind: "token", wordId: "w2" },
    ]);

    expect(existsSync(rawCachePath(paths, { name: "fake-test" }, "c1"))).toBe(true);
    expect(existsSync(join(paths.transcriptsDir, "silences-c1.json"))).toBe(true);
    expect(existsSync(paths.asrWav("c1"))).toBe(true); // made from the original because import hadn't
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1]!)).toBe(true);
  });

  it("reuses cached raw words instead of re-running the engine, unless forced", async () => {
    const before = await readJson(paths.transcript, TranscriptSchema);
    const again = await transcribeProject(slug, { transcriber: fake(new Error("engine must not run")) });
    expect(again).toEqual(before);
    await expect(transcribeProject(slug, { transcriber: fake(new Error("engine ran")), force: true })).rejects.toThrow("engine ran");
  });

  it("fails fast without an OpenAI key when the OpenAI transcript isn't cached", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(transcribeProject(slug, { engine: "openai" })).rejects.toThrow(MISSING_KEY_MESSAGE);
  });
});
