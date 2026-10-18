// The Hono app: every route of the contract in ./api.ts, the media file server and (in production)
// the built UI. createApp() takes injectable dependencies so tests never touch Claude, ASR or ffmpeg.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { REPO_ROOT, projectPaths } from "../core/paths.ts";
import { EditSchema, EditStyleOverridesSchema, StageName, TranscriptSchema, type Project } from "../core/schema.ts";
import { restyle } from "../pipeline/restyle.ts";
import { listProjects, loadProject, readJsonIfExists, setStage, writeJson } from "../core/store.ts";
import { buildTimeline } from "../core/timeline.ts";
import { runStage } from "../pipeline/index.ts";
import { withDeps, type PipelineDeps } from "../pipeline/types.ts";
import type {
  FileListing, Health, JobInfo, SaveEditConflict, SaveEditResponse, ScriptEntry,
} from "./api.ts";
import { buildBundle } from "./bundle.ts";
import { EventBus, sseResponse } from "./events.ts";
import { FilesError, listFolder, listScripts } from "./files.ts";
import { cached, claudeAuthStatus, health } from "./health.ts";
import { JobConflictError, JobManager, type JobManagerOptions } from "./jobs.ts";
import { safeResolve, sendFile } from "./media.ts";
import {
  SLUG_RE, addAsset, addClips, bad, createProject, deleteAsset, notFound, parseBody, patchAsset, patchClip, patchProject,
  probeImage, removeClip, type ProbeImage,
} from "./projects.ts";

export type AppDeps = {
  pipeline?: Partial<PipelineDeps>; // stage dependencies (fakes in tests)
  claudeLoggedIn?: () => Promise<boolean>; // default: cached `claude auth status`
  homeDir?: string; // /api/files is confined to this folder (default: the user's home)
  probeImage?: ProbeImage;
  webDist?: string | null; // built UI folder; null disables static serving (default web/dist)
  previewDebounceMs?: number; // after PUT /edit (default 800)
  jobs?: JobManagerOptions;
};

export type ServerApp = {
  app: Hono;
  jobs: JobManager;
  bus: EventBus;
  /** Cancel running jobs and pending auto-previews. */
  dispose(): void;
};

const LOCAL_MODELS = ["tiny.en", "base.en", "small.en", "medium.en", "large-v3"] as const;
const STAGE_OPTIONS: Partial<Record<StageName, z.ZodType>> = {
  transcribe: z.object({
    engine: z.enum(["local", "openai"]).optional(),
    localEngine: z.enum(["whisper", "parakeet"]).optional(),
    localModel: z.enum(LOCAL_MODELS).optional(),
    force: z.boolean().optional(),
  }),
  graphics: z.object({
    cueIds: z.array(z.string().min(1)).optional(),
    note: z.string().optional(),
    force: z.boolean().optional(),
  }),
  xclips: z.object({ count: z.number().int().min(1).max(3).optional() }),
  import: z.object({ then: z.enum(["transcribe", "preview"]).optional() }),
  plan: z.object({ keepGraphics: z.boolean().optional() }),
  preview: z.object({ sweep: z.boolean().optional() }), // sweep: listen back and cut leftover ums
};

async function jsonBody(c: Context, optional = false): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (optional) return {};
    throw bad("Request body must be JSON");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw bad("Request body must be JSON");
  }
}

async function requireProject(slug: string): Promise<Project> {
  if (!SLUG_RE.test(slug) || !existsSync(projectPaths(slug).project)) throw notFound(`No project "${slug}"`);
  return loadProject(slug);
}

/** Path segments after /media/<slug>/, percent-decoded one by one (so an encoded "/" or ".." is caught by safeResolve). */
function mediaRelPath(c: Context, slug: string): string | null {
  const raw = new URL(c.req.url).pathname;
  const prefix = `/media/${encodeURIComponent(slug)}/`;
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.split("/").slice(3).join("/");
  try {
    return rest.split("/").map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLocalHostname = (h: string) => LOCAL_HOSTNAMES.has(h) || h.endsWith(".localhost");

/**
 * Only local pages may talk to the server: a Host header that is not localhost (DNS rebinding) or an
 * Origin from another site (a web page POSTing to 127.0.0.1) gets a 403. The Vite dev server's proxy
 * (Host/Origin localhost:5173) passes.
 */
export function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  try {
    if (host && !isLocalHostname(new URL(`http://${host}`).hostname)) return false;
    if (origin && !isLocalHostname(new URL(origin).hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Mark stages a stopped server left "running" as interrupted (call once at startup). */
export async function recoverInterruptedStages(): Promise<void> {
  for (const p of await listProjects().catch(() => [])) {
    for (const [stage, status] of Object.entries(p.stages)) {
      if (status?.state === "running") {
        await setStage(p.slug, stage as StageName, { state: "error", message: "Interrupted (the server stopped) — run it again" }).catch(() => undefined);
      }
    }
  }
}

export function createApp(deps: AppDeps = {}): ServerApp {
  const pipeline = withDeps(deps.pipeline);
  const bus = new EventBus();
  const jobs = new JobManager(bus, (stage, slug, ctx) => runStage(stage, slug, ctx, pipeline), deps.jobs);
  const claudeLoggedIn = deps.claudeLoggedIn ?? cached(() => claudeAuthStatus());
  const home = deps.homeDir ?? homedir();
  const imageProbe = deps.probeImage ?? probeImage;
  const webDist = deps.webDist === undefined ? join(REPO_ROOT, "web", "dist") : deps.webDist;
  const debounceMs = deps.previewDebounceMs ?? 800;
  const previewTimers = new Map<string, NodeJS.Timeout>();
  const editLocks = new Map<string, Promise<unknown>>();

  const changed = (slug: string) => bus.emit(slug, { type: "bundle-changed" });
  const startQuietly = (slug: string, stage: StageName) =>
    jobs.restart(slug, stage).catch((err: unknown) => console.error(`[server] could not start ${stage} for ${slug}:`, err));

  /** After an edit save: cancel the running preview now, build a fresh one once edits pause for debounceMs. */
  const schedulePreview = (slug: string) => {
    clearTimeout(previewTimers.get(slug));
    jobs.cancelStage(slug, "preview");
    const t = setTimeout(() => {
      previewTimers.delete(slug);
      void startQuietly(slug, "preview");
    }, debounceMs);
    t.unref?.();
    previewTimers.set(slug, t);
  };

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof JobConflictError) return c.json({ error: err.message, job: err.job }, 409);
    console.error(`[server] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err.message || "Internal error" }, 500);
  });

  app.use("*", async (c, next) => {
    if (!isLocalRequest(c.req.header("host"), c.req.header("origin"))) return c.json({ error: "Forbidden: local requests only" }, 403);
    await next();
  });

  // ---------- app-wide ----------

  app.get("/api/health", async (c) => c.json<Health>(await health(claudeLoggedIn)));

  app.get("/api/config", async (c) => c.json(await pipeline.loadConfig()));

  app.get("/api/scripts", async (c) => {
    const config = await pipeline.loadConfig();
    return c.json<ScriptEntry[]>(await listScripts(config.scriptsDir));
  });

  app.get("/api/files", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "video" && kind !== "image") throw bad('kind must be "video" or "image"');
    try {
      return c.json<FileListing>(await listFolder(c.req.query("dir"), kind, home));
    } catch (err) {
      if (err instanceof FilesError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // ---------- projects ----------

  app.get("/api/projects", async (c) => c.json<Project[]>(await listProjects()));

  app.post("/api/projects", async (c) => {
    const project = await createProject(await jsonBody(c), pipeline);
    if (project.clips.length) jobs.start(project.slug, "import");
    return c.json<Project>(project, 201);
  });

  app.get("/api/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    return c.json(await buildBundle(slug, jobs, pipeline));
  });

  app.patch("/api/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const project = await patchProject(slug, await jsonBody(c));
    changed(slug);
    return c.json<Project>(project);
  });

  app.post("/api/projects/:slug/clips", async (c) => {
    const slug = c.req.param("slug");
    const current = await requireProject(slug);
    const project = await addClips(slug, await jsonBody(c), pipeline, current);
    changed(slug);
    void startQuietly(slug, "import");
    return c.json<Project>(project);
  });

  // Picture fixes: rebuild the clip's master and proxy, then the preview (no re-transcribe: no words change)
  app.patch("/api/projects/:slug/clips/:clipId", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const { project, changed: fixed } = await patchClip(slug, c.req.param("clipId"), await jsonBody(c));
    changed(slug);
    if (fixed) jobs.restart(slug, "import", { then: "preview" }).catch((err: unknown) => console.error(`[server] could not start import for ${slug}:`, err));
    return c.json<Project>(project);
  });

  app.delete("/api/projects/:slug/clips/:clipId", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const { project, editChanged } = await removeClip(slug, c.req.param("clipId"));
    changed(slug);
    if (editChanged) schedulePreview(slug);
    return c.json<Project>(project);
  });

  // ---------- assets ----------

  app.post("/api/projects/:slug/assets", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const body = await c.req.parseBody().catch(() => {
      throw bad('Send the image as multipart/form-data with the field "file"');
    });
    const asset = await addAsset(slug, body.file, imageProbe);
    changed(slug);
    return c.json(asset, 201);
  });

  app.patch("/api/projects/:slug/assets/:assetId", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const asset = await patchAsset(slug, c.req.param("assetId"), await jsonBody(c));
    changed(slug);
    return c.json(asset);
  });

  app.delete("/api/projects/:slug/assets/:assetId", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const project = await deleteAsset(slug, c.req.param("assetId"));
    changed(slug);
    return c.json<Project>(project);
  });

  // ---------- stages and jobs ----------

  app.post("/api/projects/:slug/stages/:stage", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const stage = StageName.safeParse(c.req.param("stage"));
    if (!stage.success) throw notFound(`Unknown stage "${c.req.param("stage")}"`);
    const body = parseBody(z.object({ options: z.unknown().optional() }), await jsonBody(c, true));
    const schema = STAGE_OPTIONS[stage.data];
    const options = schema ? parseBody(schema, body.options ?? {}) : undefined;
    if (stage.data === "preview") {
      clearTimeout(previewTimers.get(slug));
      previewTimers.delete(slug);
    }
    return c.json<JobInfo>(jobs.start(slug, stage.data, options)); // JobConflictError -> 409 in onError
  });

  app.post("/api/projects/:slug/jobs/:jobId/cancel", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    const job = jobs.cancel(slug, c.req.param("jobId"));
    if (!job) throw notFound(`No job ${c.req.param("jobId")}`);
    return c.json<JobInfo>(job);
  });

  // ---------- the edit ----------

  app.put("/api/projects/:slug/edit", async (c) => {
    const slug = c.req.param("slug");
    const project = await requireProject(slug);
    const body = parseBody(z.object({ edit: EditSchema }), await jsonBody(c));
    // one save at a time per project, so the version check and the write are atomic
    const prev = editLocks.get(slug) ?? Promise.resolve();
    const result = prev.then(async (): Promise<Response> => {
      const p = projectPaths(slug);
      const stored = await readJsonIfExists(p.edit, EditSchema).catch(() => null);
      if (stored && body.edit.version !== stored.version) {
        return c.json<SaveEditConflict>({ error: "conflict", current: stored }, 409);
      }
      const transcript = await readJsonIfExists(p.transcript, TranscriptSchema);
      if (!transcript) throw bad("No transcript yet — run Transcribe first");
      const next = { ...body.edit, version: (stored?.version ?? body.edit.version) + 1 };
      const timeline = buildTimeline(next, transcript, project.clips, await pipeline.loadConfig());
      const edit = await writeJson(p.edit, EditSchema, next);
      changed(slug);
      schedulePreview(slug);
      return c.json<SaveEditResponse>({ edit, timeline });
    });
    editLocks.set(slug, result.catch(() => undefined));
    return result;
  });

  // Edit style: merge this video's overrides into edit.style and re-apply it (filler cuts on/off by
  // length, sliver segments dropped). A new version, so open review screens reload it.
  app.post("/api/projects/:slug/style", async (c) => {
    const slug = c.req.param("slug");
    const project = await requireProject(slug);
    // a null value puts that setting back to the channel default
    const body = parseBody(z.object({ style: z.record(z.string(), z.unknown()) }), await jsonBody(c));
    const cleared = Object.keys(body.style).filter((k) => body.style[k] === null);
    const set = parseBody(EditStyleOverridesSchema, Object.fromEntries(Object.entries(body.style).filter(([, v]) => v !== null)));
    const prev = editLocks.get(slug) ?? Promise.resolve();
    const result = prev.then(async (): Promise<Response> => {
      const p = projectPaths(slug);
      const stored = await readJsonIfExists(p.edit, EditSchema);
      const transcript = await readJsonIfExists(p.transcript, TranscriptSchema);
      if (!stored || !transcript) throw bad("No edit yet — run Plan edit first");
      const config = await pipeline.loadConfig();
      const merged: Record<string, unknown> = { ...stored.style, ...set };
      for (const k of cleared) delete merged[k];
      const withStyle = { ...stored, style: EditStyleOverridesSchema.parse(merged) };
      const next = { ...(await restyle(slug, withStyle, { config, clips: project.clips, transcript })), version: stored.version + 1 };
      const edit = await writeJson(p.edit, EditSchema, next);
      const timeline = buildTimeline(edit, transcript, project.clips, config);
      changed(slug);
      schedulePreview(slug);
      return c.json<SaveEditResponse>({ edit, timeline });
    });
    editLocks.set(slug, result.catch(() => undefined));
    return result;
  });

  // ---------- live events ----------

  app.get("/api/projects/:slug/events", async (c) => {
    const slug = c.req.param("slug");
    await requireProject(slug);
    return sseResponse(c, bus, slug);
  });

  // ---------- media ----------

  app.get("/media/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!SLUG_RE.test(slug)) return c.json({ error: "Not found" }, 404);
    const rel = mediaRelPath(c, slug);
    const file = rel ? safeResolve(projectPaths(slug).root, rel) : null;
    if (!file) return c.json({ error: "Not found" }, 404);
    return sendFile(c, file, { cacheControl: "no-cache" }); // no-cache = revalidate (ETag); preview.mp4 and renders change in place
  });

  // ---------- the built UI (production) ----------

  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/api" || path.startsWith("/api/") || path.startsWith("/media/")) return c.json({ error: "Not found" }, 404);
    if (!webDist || !existsSync(join(webDist, "index.html"))) {
      return c.text("fde-editor API server. The UI is not built: use `pnpm dev`, or `pnpm build` then `pnpm start`.", 404);
    }
    let rel = "";
    try {
      rel = decodeURIComponent(path).replace(/^\/+/, "");
    } catch {
      // malformed escape: fall through to index.html
    }
    const file = rel ? safeResolve(webDist, rel) : null;
    if (file && existsSync(file) && statSync(file).isFile()) {
      const hashed = rel.startsWith("assets/");
      return sendFile(c, file, { cacheControl: hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    }
    return sendFile(c, join(webDist, "index.html")); // SPA fallback
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return {
    app,
    jobs,
    bus,
    dispose() {
      for (const t of previewTimers.values()) clearTimeout(t);
      previewTimers.clear();
      jobs.cancelAll();
    },
  };
}
