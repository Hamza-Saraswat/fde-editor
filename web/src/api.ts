// The UI's view of the server: one interface, two implementations (HTTP here, in-memory in dev/mock.ts).
import type {
  Asset, Config, CreateProjectBody, Edit, FileListing, Health, JobInfo, PatchAssetBody, PatchProjectBody, Project,
  ProjectBundle, SaveEditResponse, ScriptEntry, ServerEvent, StageName, StageOptions,
} from "./types.ts";

export type StageRunOptions = StageOptions[keyof StageOptions];
export type ConnectionState = "connecting" | "open" | "error";

export interface ApiClient {
  readonly mock: boolean;
  health(): Promise<Health>;
  config(): Promise<Config>;
  scripts(): Promise<ScriptEntry[]>;
  files(dir?: string, kind?: "video" | "image"): Promise<FileListing>;
  projects(): Promise<Project[]>;
  createProject(body: CreateProjectBody): Promise<Project>;
  bundle(slug: string): Promise<ProjectBundle>;
  patchProject(slug: string, body: PatchProjectBody): Promise<Project>;
  addClips(slug: string, paths: string[]): Promise<Project>;
  removeClip(slug: string, clipId: string): Promise<Project>;
  uploadAsset(slug: string, file: File): Promise<Asset>;
  patchAsset(slug: string, assetId: string, body: PatchAssetBody): Promise<Asset>;
  deleteAsset(slug: string, assetId: string): Promise<Project>;
  runStage(slug: string, stage: StageName, options?: StageRunOptions): Promise<JobInfo>;
  cancelJob(slug: string, jobId: string): Promise<JobInfo>;
  /** Throws EditConflictError (409) when the stored version moved on. */
  saveEdit(slug: string, edit: Edit): Promise<SaveEditResponse>;
  /** Live events for one project. Returns an unsubscribe function. */
  subscribe(slug: string, onEvent: (e: ServerEvent) => void, onState?: (s: ConnectionState) => void): () => void;
  /** URL for a file inside the project folder (path relative to it, e.g. assets/a1.png or proxy/c1.mp4). */
  mediaUrl(slug: string, rel: string): string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown = null) {
    super(message);
    this.name = "ApiError";
  }
}

export class EditConflictError extends ApiError {
  constructor(public current: Edit) {
    super(409, "This edit was changed somewhere else.");
    this.name = "EditConflictError";
  }
}

async function request<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, "Can't reach the fde-editor server. Start it with `pnpm dev:server` (or `pnpm dev` for both).");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    // the dev proxy answers 502/504 with no JSON when the API server isn't running
    if ((res.status === 502 || res.status === 503 || res.status === 504) && (data === null || typeof data === "string")) {
      throw new ApiError(res.status, "Can't reach the fde-editor server. Start it with `pnpm dev:server` (or `pnpm dev` for both).");
    }
    const d = data as { error?: unknown; message?: unknown; current?: unknown } | null;
    if (res.status === 409 && d && d.error === "conflict" && d.current) throw new EditConflictError(d.current as Edit);
    const msg = typeof d?.message === "string" ? d.message : typeof d?.error === "string" ? d.error : typeof data === "string" && data ? data : res.statusText;
    throw new ApiError(res.status, msg || `Request failed (${res.status})`, data);
  }
  return data as T;
}

const enc = encodeURIComponent;
const P = (slug: string) => `/api/projects/${enc(slug)}`;
const EVENT_TYPES = ["stage", "job", "log", "claude", "graphic", "bundle-changed"] as const;

export function createHttpClient(): ApiClient {
  return {
    mock: false,
    health: () => request("GET", "/api/health"),
    config: () => request("GET", "/api/config"),
    scripts: () => request("GET", "/api/scripts"),
    files: (dir, kind) => {
      const q = new URLSearchParams();
      if (dir) q.set("dir", dir);
      if (kind) q.set("kind", kind);
      const qs = q.toString();
      return request("GET", `/api/files${qs ? `?${qs}` : ""}`);
    },
    projects: () => request("GET", "/api/projects"),
    createProject: (body) => request("POST", "/api/projects", body),
    bundle: (slug) => request("GET", P(slug)),
    patchProject: (slug, body) => request("PATCH", P(slug), body),
    addClips: (slug, paths) => request("POST", `${P(slug)}/clips`, { paths }),
    removeClip: (slug, clipId) => request("DELETE", `${P(slug)}/clips/${enc(clipId)}`),
    uploadAsset: (slug, file) => {
      const form = new FormData();
      form.append("file", file);
      return request("POST", `${P(slug)}/assets`, undefined, form);
    },
    patchAsset: (slug, assetId, body) => request("PATCH", `${P(slug)}/assets/${enc(assetId)}`, body),
    deleteAsset: (slug, assetId) => request("DELETE", `${P(slug)}/assets/${enc(assetId)}`),
    runStage: (slug, stage, options) => request("POST", `${P(slug)}/stages/${stage}`, options === undefined ? {} : { options }),
    cancelJob: (slug, jobId) => request("POST", `${P(slug)}/jobs/${enc(jobId)}/cancel`, {}),
    saveEdit: (slug, edit) => request("PUT", `${P(slug)}/edit`, { edit }),
    subscribe(slug, onEvent, onState) {
      // EventSource gives up for good when a (re)connect gets a non-200 answer, which is exactly what
      // the dev proxy returns (502) while the API server restarts. So reconnect ourselves with
      // backoff, and after every reconnect ask the UI to re-fetch whatever it missed meanwhile.
      let es: EventSource | null = null;
      let stopped = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      let opened = false;
      const handle = (name: string) => (ev: MessageEvent<string>) => {
        try {
          const data = JSON.parse(ev.data) as ServerEvent | Record<string, unknown>;
          // Accept both unnamed events carrying {type} and named events ("event: job").
          if (!("type" in data) && name !== "message") (data as Record<string, unknown>).type = name;
          onEvent(data as ServerEvent);
        } catch {
          /* ignore keep-alives and malformed lines */
        }
      };
      const connect = () => {
        if (stopped) return;
        onState?.("connecting");
        const src = new EventSource(`${P(slug)}/events`);
        es = src;
        src.onmessage = handle("message");
        for (const t of EVENT_TYPES) src.addEventListener(t, handle(t) as EventListener);
        src.onopen = () => {
          delay = 1000;
          onState?.("open");
          if (opened) onEvent({ type: "bundle-changed" });
          opened = true;
        };
        src.onerror = () => {
          if (src.readyState !== EventSource.CLOSED) return onState?.("connecting"); // browser retries itself
          src.close();
          onState?.("error");
          if (!stopped) retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        };
      };
      connect();
      return () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        es?.close();
      };
    },
    mediaUrl: (slug, rel) => `/media/${enc(slug)}/${rel.split("/").map(enc).join("/")}`,
  };
}
