import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projectPaths } from "../src/core/paths.ts";
import { EditSchema, ScriptDocSchema, TranscriptSchema, type Edit, type Project, type Transcript } from "../src/core/schema.ts";
import { readJson, writeJson } from "../src/core/store.ts";
import type { PipelineDeps } from "../src/pipeline/types.ts";
import type { FileListing, Health, JobInfo, ProjectBundle, SaveEditResponse } from "../src/server/api.ts";
import { createApp, type ServerApp } from "../src/server/index.ts";
import { parseRange } from "../src/server/media.ts";

const ROOT = mkdtempSync(join(tmpdir(), "fde-server-"));
const prevProjectsDir = process.env.FDE_PROJECTS_DIR;
process.env.FDE_PROJECTS_DIR = join(ROOT, "projects");
const HOME = join(ROOT, "home");
const CLIP = join(HOME, "rec", "take 1.mp4");
const PNG = join(HOME, "shot.png");
const FIXTURE_SCRIPT = resolve("test/fixtures/scripts/01-what-is-an-ai-engineer.md");

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fake pipeline: no ASR, no Claude, no encoding ----------

const prepareClip = vi.fn<PipelineDeps["prepareClip"]>(async (_slug, _clip, opts) => {
  opts?.onProgress?.(0.5, "half way");
  return { proxy: "", wav: "", asrWav: "", asrMp3: "", made: ["proxy", "wav", "asrWav", "asrMp3"] };
});

/** "Speaks" the script's first sentence, 0.1 s per word. */
const transcribeProject = vi.fn<PipelineDeps["transcribeProject"]>(async (slug) => {
  const p = projectPaths(slug);
  const script = await readJson(p.script, ScriptDocSchema);
  const texts = script.sentences[0]!.text.split(/\s+/);
  const transcript: Transcript = {
    engine: "fake", model: "fake", silences: [], fillers: [],
    words: texts.map((text, i) => ({ id: `w${i}`, clipId: "c1", text, start: 0.1 + i * 0.1, end: 0.18 + i * 0.1 })),
  };
  return writeJson(p.transcript, TranscriptSchema, transcript);
});

const buildPreview = vi.fn<PipelineDeps["buildPreview"]>(async (slug, timeline) => {
  const out = projectPaths(slug).preview;
  mkdirSync(projectPaths(slug).outDir, { recursive: true });
  writeFileSync(out, "fake mp4");
  return { path: out, frames: Math.round(timeline.duration * 30), duration: timeline.duration, encoded: timeline.segments.length, reused: 0, ms: 1 };
});

/** Plans "forever" until cancelled. */
const planEdit = vi.fn<PipelineDeps["planEdit"]>((_slug, opts) =>
  new Promise((_resolve, reject) => {
    opts?.onEvent?.({ kind: "init", model: "opus", sessionId: "s" });
    opts?.signal?.addEventListener("abort", () => reject(new Error("cancelled")));
  }));

const fakes: Partial<PipelineDeps> = {
  prepareClip,
  transcribeProject,
  buildPreview,
  planEdit,
  graphicStatuses: async () => ({}),
};

let server: ServerApp;
const req = (path: string, init?: RequestInit) => server.app.request(path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => {
  mkdirSync(join(HOME, "rec"), { recursive: true });
  ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2",
    "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", CLIP]);
  ff(["-f", "lavfi", "-i", "color=c=blue:s=64x32", "-frames:v", "1", PNG]);
  server = createApp({ pipeline: fakes, claudeLoggedIn: async () => true, homeDir: HOME, webDist: null, previewDebounceMs: 30 });
});

afterAll(async () => {
  server.dispose();
  await server.jobs.idle().catch(() => undefined);
  if (prevProjectsDir === undefined) delete process.env.FDE_PROJECTS_DIR;
  else process.env.FDE_PROJECTS_DIR = prevProjectsDir;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("health", () => {
  it("reports each prerequisite without leaking the OpenAI key", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-secret-value";
    try {
      const res = await req("/api/health");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("sk-test");
      const h = JSON.parse(text) as Health;
      expect(h).toEqual({ ok: true, claudeLoggedIn: true, openaiKey: true, hyperframesVersion: expect.stringMatching(/^\d+\.\d+/), brandReady: expect.any(Boolean) });
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("projects", () => {
  let slug = "";

  it("creates a project from a script and a recording, then imports and transcribes it", async () => {
    const res = await req("/api/projects", json("POST", { scriptPath: FIXTURE_SCRIPT, speakerSide: "left", clipPaths: [CLIP] }));
    expect(res.status).toBe(201);
    const project = (await res.json()) as Project;
    slug = project.slug;
    expect(slug).toBe("what-is-an-ai-engineer-it-s-actually-two-different-jobs");
    expect(project.title).toBe("What Is an AI Engineer? (It's Actually Two Different Jobs)");
    expect(project.clips).toEqual([expect.objectContaining({ id: "c1", name: "take 1.mp4", width: 320, height: 180, hasAudio: true, hdr: false })]);
    const p = projectPaths(slug);
    expect(await readFile(p.scriptMd, "utf8")).toBe(await readFile(FIXTURE_SCRIPT, "utf8"));

    await server.jobs.idle();
    expect(prepareClip).toHaveBeenCalledTimes(1);
    expect(transcribeProject).toHaveBeenCalledTimes(1);

    const bundle = (await (await req(`/api/projects/${slug}`)).json()) as ProjectBundle;
    expect(bundle.project.stages.import).toMatchObject({ state: "done", message: "1 clip prepared (4 files written)", progress: 1 });
    expect(bundle.project.stages.transcribe?.state).toBe("done");
    expect(bundle.project.stages.transcribe?.message).toMatch(/^\d+ words · 0 filler candidates · 1\/\d+ script sentences matched · \d+ missing/);
    expect(bundle.script?.sentences.length).toBeGreaterThan(10);
    expect(bundle.transcript?.words.length).toBeGreaterThan(5);
    expect(bundle.candidates?.sentences[0]?.chosen).toBe(0);
    expect(bundle.edit).toBeNull();
    expect(bundle.timeline).toBeNull();
    expect(bundle.graphics).toEqual({});
    expect(bundle.outputs).toEqual({ xclips: [] });
    expect(bundle.jobs.map((j) => [j.stage, j.state])).toEqual([["transcribe", "done"], ["import", "done"]]);

    const list = (await (await req("/api/projects")).json()) as Project[];
    expect(list.map((x) => x.slug)).toContain(slug);
  });

  it("makes slugs unique and rejects HDR recordings", async () => {
    const res = await req("/api/projects", json("POST", { scriptPath: FIXTURE_SCRIPT, title: "Short title", speakerSide: "right", clipPaths: [] }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Project).slug).toBe("short-title");
    const again = await req("/api/projects", json("POST", { scriptPath: FIXTURE_SCRIPT, title: "Short title", speakerSide: "right", clipPaths: [] }));
    expect(((await again.json()) as Project).slug).toBe("short-title-2");

    const hdrApp = createApp({
      webDist: null,
      pipeline: { probeClip: async (path, id) => ({ id, name: "hdr.mov", path, duration: 2, width: 320, height: 180, fps: 30, codec: "hevc", pixFmt: "yuv420p10le", hasAudio: true, vfr: false, hdr: true }) },
    });
    const hdr = await hdrApp.app.request("/api/projects", json("POST", { scriptPath: FIXTURE_SCRIPT, title: "HDR video", speakerSide: "left", clipPaths: [CLIP] }));
    expect(hdr.status).toBe(400);
    expect(((await hdr.json()) as { error: string }).error).toMatch(/Record in SDR/);
    expect(existsSync(projectPaths("hdr-video").root)).toBe(false);

    const missing = await req("/api/projects", json("POST", { scriptPath: join(ROOT, "nope.md"), speakerSide: "left", clipPaths: [] }));
    expect(missing.status).toBe(400);
  });

  it("patches project fields and 404s unknown projects and stages", async () => {
    const res = await req(`/api/projects/${slug}`, json("PATCH", { nextVideoTitle: "Next: agents" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Project).nextVideoTitle).toBe("Next: agents");
    expect((await req("/api/projects/no-such-project")).status).toBe(404);
    expect((await req(`/api/projects/${slug}/stages/dance`, { method: "POST" })).status).toBe(404);
    expect((await req(`/api/projects/${slug}`, json("PATCH", { speakerSide: "upside-down" }))).status).toBe(400);
  });

  it("rejects a second run of a running stage (409) and cancels a job", async () => {
    const start = await req(`/api/projects/${slug}/stages/plan`, json("POST", {}));
    expect(start.status).toBe(200);
    const job = (await start.json()) as JobInfo;
    expect(job).toMatchObject({ stage: "plan", state: "running" });
    await sleep(20);
    const conflict = await req(`/api/projects/${slug}/stages/plan`, { method: "POST" });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { job: JobInfo }).job.id).toBe(job.id);

    expect((await req(`/api/projects/${slug}/jobs/${job.id}/cancel`, { method: "POST" })).status).toBe(200);
    await server.jobs.idle();
    const bundle = (await (await req(`/api/projects/${slug}`)).json()) as ProjectBundle;
    expect(bundle.jobs.find((j) => j.id === job.id)).toMatchObject({ state: "cancelled", message: "Cancelled" });
    expect(bundle.project.stages.plan).toMatchObject({ state: "idle", message: "Cancelled" });
    expect((await req(`/api/projects/${slug}/jobs/nope/cancel`, { method: "POST" })).status).toBe(404);
  });

  it("saves the edit with a version check and rebuilds the preview after a pause", async () => {
    const p = projectPaths(slug);
    const transcript = await readJson(p.transcript, TranscriptSchema);
    const last = transcript.words.at(-1)!.id;
    const edit: Edit = EditSchema.parse({
      version: 3, clipOrder: ["c1"], cuts: [], overlays: [], chapters: [{ title: "Cold open", anchorWordId: "w0" }],
      takeGroups: [{ id: "tg1", sentenceIds: ["s0.1"], options: [{ startWordId: "w0", endWordId: last, clipId: "c1", start: 0.1, end: 2 }], chosen: 0, why: "" }],
    });
    await writeJson(p.edit, EditSchema, edit);
    buildPreview.mockClear();

    const stale = await req(`/api/projects/${slug}/edit`, json("PUT", { edit: { ...edit, version: 2 } }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", current: { version: 3 } });

    expect((await req(`/api/projects/${slug}/edit`, json("PUT", { edit: { version: 3 } }))).status).toBe(400);

    const ok = await req(`/api/projects/${slug}/edit`, json("PUT", { edit: { ...edit, cuts: [{ id: "u1", clipId: "c1", start: 0.5, end: 0.7, reason: "user", by: "user", enabled: true }] } }));
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as SaveEditResponse;
    expect(saved.edit.version).toBe(4);
    expect(saved.timeline.segments.length).toBeGreaterThanOrEqual(2);
    expect((await readJson(p.edit, EditSchema)).version).toBe(4);

    await sleep(60); // past the 30 ms debounce
    await server.jobs.idle();
    expect(buildPreview).toHaveBeenCalledTimes(1);
    const bundle = (await (await req(`/api/projects/${slug}`)).json()) as ProjectBundle;
    expect(bundle.jobs[0]).toMatchObject({ stage: "preview", state: "done" });
    expect(bundle.timeline?.chapters).toEqual([{ title: "Cold open", start: 0 }]);
    expect(bundle.outputs.preview).toMatch(new RegExp(`^/media/${slug}/out/preview\\.mp4\\?v=\\d+$`));
  });

  it("serves project media with Range support and blocks path traversal", async () => {
    const p = projectPaths(slug);
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    mkdirSync(p.outDir, { recursive: true });
    writeFileSync(join(p.outDir, "test.bin"), bytes);
    writeFileSync(join(ROOT, "projects", "secret.txt"), "TOP SECRET");

    const part = await req(`/media/${slug}/out/test.bin`, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(part.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    const suffix = await req(`/media/${slug}/out/test.bin`, { headers: { range: "bytes=-3" } });
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([253, 254, 255]);
    expect((await req(`/media/${slug}/out/test.bin`, { headers: { range: "bytes=300-" } })).status).toBe(416);

    const whole = await req(`/media/${slug}/out/test.bin`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect((await whole.arrayBuffer()).byteLength).toBe(256);

    const preview = await req(`/media/${slug}/out/preview.mp4`);
    expect(preview.headers.get("content-type")).toBe("video/mp4");
    expect(preview.headers.get("cache-control")).toBe("no-cache");
    const etag = preview.headers.get("etag")!;
    expect((await req(`/media/${slug}/out/preview.mp4`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await req(`/media/${slug}/script.md`)).headers.get("content-type")).toMatch(/^text\/plain/);

    for (const path of [`/media/${slug}/..%2fsecret.txt`, `/media/${slug}/out/..%2F..%2F..%2Fsecret.txt`, `/media/${slug}/%2e%2e/secret.txt`,
      `/media/${slug}/out/../../secret.txt`, `/media/..%2f/secret.txt`, `/media/${slug}/%2fetc%2fpasswd`, `/media/${slug}/out/missing.mp4`]) {
      const res = await req(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("TOP SECRET");
    }
  });

  it("uploads, patches and deletes an image asset", async () => {
    const form = new FormData();
    form.append("file", new File([await readFile(PNG)], "job post.png", { type: "image/png" }));
    const res = await req(`/api/projects/${slug}/assets`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const asset = await res.json();
    expect(asset).toMatchObject({ id: "a1", name: "job post.png", file: "assets/a1.png", kind: "image", width: 64, height: 32, blur: [], highlight: [] });
    expect(existsSync(join(projectPaths(slug).root, "assets", "a1.png"))).toBe(true);

    const patched = await req(`/api/projects/${slug}/assets/a1`, json("PATCH", { cueId: "r1", crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, blur: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }));
    expect(await patched.json()).toMatchObject({ cueId: "r1", crop: { w: 0.5 }, blur: [{ x: 0.1 }] });
    const cleared = await req(`/api/projects/${slug}/assets/a1`, json("PATCH", { cueId: null, crop: null }));
    const c = await cleared.json();
    expect(c.cueId).toBeUndefined();
    expect(c.crop).toBeUndefined();

    const bad = new FormData();
    bad.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect((await req(`/api/projects/${slug}/assets`, { method: "POST", body: bad })).status).toBe(400);

    const del = await req(`/api/projects/${slug}/assets/a1`, { method: "DELETE" });
    expect(((await del.json()) as Project).assets).toEqual([]);
    expect(existsSync(join(projectPaths(slug).root, "assets", "a1.png"))).toBe(false);
  });

  it("streams job events over SSE", async () => {
    const res = await req(`/api/projects/${slug}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"
    expect(server.bus.listeners(slug)).toBe(1);

    expect((await req(`/api/projects/${slug}/stages/align`, { method: "POST" })).status).toBe(200);
    let text = "";
    while (!text.includes('"type":"job"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const first = text.split("\n").find((l) => l.startsWith("data: ") && l.includes('"type":"job"'))!;
    expect(JSON.parse(first.slice(6))).toMatchObject({ type: "job", job: { stage: "align", state: "running" } });
    await reader.cancel();
    await sleep(10);
    expect(server.bus.listeners(slug)).toBe(0);
    await server.jobs.idle();
  });
});

describe("files", () => {
  it("refuses folders outside the home folder", async () => {
    for (const dir of ["/etc", join(HOME, ".."), "/"]) {
      const res = await req(`/api/files?dir=${encodeURIComponent(dir)}`);
      expect(res.status, dir).toBe(403);
    }
    expect((await req(`/api/files?dir=${encodeURIComponent(join(HOME, "nope"))}`)).status).toBe(404);
    expect((await req(`/api/files?kind=audio`)).status).toBe(400);
  });

  it("lists folders first, then matching files newest first, hiding dotfiles", async () => {
    const dir = join(HOME, "Videos");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const touch = (name: string, ageSec: number) => {
      writeFileSync(join(dir, name), "x");
      const t = Date.now() / 1000 - ageSec;
      utimesSync(join(dir, name), t, t);
    };
    touch("old.mp4", 100);
    touch("new.MOV", 10);
    touch("notes.txt", 5);
    touch(".hidden.mp4", 1);
    touch("pic.png", 1);
    const listing = (await (await req(`/api/files?dir=${encodeURIComponent(dir)}&kind=video`)).json()) as FileListing;
    expect(listing.dir).toBe(dir);
    expect(listing.parent).toBe(HOME);
    expect(listing.entries.map((e) => [e.name, e.isDir])).toEqual([["sub", true], ["new.MOV", false], ["old.mp4", false]]);
    const images = (await (await req(`/api/files?dir=${encodeURIComponent(dir)}&kind=image`)).json()) as FileListing;
    expect(images.entries.map((e) => e.name)).toEqual(["sub", "pic.png"]);
    const home = (await (await req(`/api/files`)).json()) as FileListing; // no ~/Downloads here: falls back to home
    expect(home.dir).toBe(HOME);
    expect(home.parent).toBeNull();
  });
});

describe("static UI", () => {
  it("serves the built UI with an SPA fallback, but never for /api or /media", async () => {
    const dist = join(ROOT, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>fde</title>");
    writeFileSync(join(dist, "assets", "app-123.js"), "console.log(1)");
    const ui = createApp({ webDist: dist, pipeline: fakes });
    const index = await ui.app.request("/");
    expect(index.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await (await ui.app.request("/projects/some-video")).text()).toContain("<title>fde</title>");
    const js = await ui.app.request("/assets/app-123.js");
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await ui.app.request("/api/nope")).status).toBe(404);
    expect((await ui.app.request("/media/nope")).status).toBe(404);
  });
});

describe("local-only guard", () => {
  it("rejects foreign Host and Origin headers but lets localhost and the Vite proxy through", async () => {
    expect((await req("/api/health", { headers: { host: "evil.example:4317" } })).status).toBe(403); // DNS rebinding
    expect((await req("/api/projects", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
    expect((await req("/api/health", { headers: { origin: "null" } })).status).toBe(403);
    expect((await req("/api/health", { headers: { host: "127.0.0.1:4317" } })).status).toBe(200);
    expect((await req("/api/health", { headers: { host: "localhost:5173", origin: "http://localhost:5173" } })).status).toBe(200);
  });
});

describe("parseRange", () => {
  it("handles open, suffix, clamped and invalid ranges", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-200", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=5-2", 100)).toBe("unsatisfiable");
    expect(parseRange("items=1-2", 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });
});
