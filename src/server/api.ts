// The HTTP contract between the server (src/server) and the UI (web/). Types only.
// All JSON. Media files are served from /media/:slug/<path relative to the project folder>.
import type {
  Asset, Candidates, Config, Edit, Project, Rect, ScriptDoc, StageName, StageStatus, Timeline, Transcript,
} from "../core/schema.ts";
import type { ClaudeEvent } from "../claude/runner.ts";

export type Health = {
  ok: true;
  claudeLoggedIn: boolean; // `claude auth status` (clean env) says loggedIn
  openaiKey: boolean; // OPENAI_API_KEY present (never the value)
  hyperframesVersion: string;
  brandReady: boolean; // brand/tokens.css + intro/outro renders exist
};

export type ScriptEntry = { path: string; title: string; folder: string; modified: string };

export type FileEntry = { name: string; path: string; isDir: boolean; size: number; modified: string };
export type FileListing = { dir: string; parent: string | null; entries: FileEntry[] };

export type CreateProjectBody = {
  scriptPath: string;
  title?: string; // defaults to the script's H1
  speakerSide: Project["speakerSide"];
  clipPaths: string[]; // absolute paths of recordings, in recording order
};

export type PatchProjectBody = Partial<Pick<Project, "title" | "speakerSide" | "nextVideoTitle">>;

export type GraphicState = "none" | "queued" | "building" | "rendering" | "ready" | "error";
export type GraphicStatus = {
  cueId: string;
  state: GraphicState;
  message: string;
  updatedAt?: string;
  durationSec?: number; // length the graphic was built for
  side?: "left" | "right";
  layout?: "side" | "split" | "full";
  still?: string; // media URL of the snapshot png
  webm?: string; // media URL of the transparent preview
  hasMov: boolean; // final ProRes 4444 render exists
  stale: boolean; // timing/side/brief changed since it was built
};

export type Outputs = {
  preview?: string; // media URLs, present only when the file exists
  previewEditVersion?: number; // edit.version the current preview.mp4 was built from
  final?: string;
  chapters?: string; // the text itself
  srt?: string; // media URL
  xclips: { url: string; hook: string; start: number; end: number }[];
};

export type ProjectBundle = {
  project: Project;
  script: ScriptDoc | null;
  transcript: Transcript | null;
  candidates: Candidates | null;
  edit: Edit | null;
  timeline: Timeline | null; // derived from edit (null until there is an edit)
  graphics: Record<string, GraphicStatus>; // by cueId
  outputs: Outputs;
  jobs: JobInfo[]; // running or recently finished
};

export type StageOptions = {
  transcribe?: { engine?: "local" | "openai"; localEngine?: "whisper" | "parakeet"; localModel?: string; force?: boolean };
  graphics?: { cueIds?: string[]; note?: string; force?: boolean };
  render?: Record<string, never>;
  xclips?: { count?: number };
};
export type RunStageBody = { options?: StageOptions[keyof StageOptions] };

export type JobInfo = {
  id: string;
  stage: StageName;
  state: "running" | "done" | "error" | "cancelled";
  startedAt: string;
  endedAt?: string;
  message: string;
  progress?: number; // 0–1
};

export type SaveEditBody = { edit: Edit }; // edit.version must equal the stored version
export type SaveEditResponse = { edit: Edit; timeline: Timeline };
export type SaveEditConflict = { error: "conflict"; current: Edit };

export type PatchAssetBody = { cueId?: string | null; crop?: Rect | null; blur?: Rect[]; highlight?: Rect[] };

// Server-sent events on GET /api/projects/:slug/events
export type ServerEvent =
  | { type: "stage"; stage: StageName; status: StageStatus }
  | { type: "job"; job: JobInfo }
  | { type: "log"; stage: StageName; line: string }
  | { type: "claude"; stage: StageName; cueId?: string; event: ClaudeEvent }
  | { type: "graphic"; status: GraphicStatus }
  | { type: "bundle-changed" }; // re-fetch GET /api/projects/:slug

/*
Routes
  GET    /api/health                                   -> Health
  GET    /api/config                                   -> Config
  GET    /api/scripts                                  -> ScriptEntry[]       (markdown scripts under config.scriptsDir)
  GET    /api/files?dir=<abs>&kind=video|image         -> FileListing         (default dir ~/Downloads; dirs + matching files only)
  GET    /api/projects                                 -> Project[]
  POST   /api/projects            CreateProjectBody    -> Project             (then auto-runs the import stage)
  GET    /api/projects/:slug                           -> ProjectBundle
  PATCH  /api/projects/:slug      PatchProjectBody     -> Project
  POST   /api/projects/:slug/clips   { paths: string[] } -> Project
  DELETE /api/projects/:slug/clips/:clipId             -> Project
  POST   /api/projects/:slug/assets  multipart "file"  -> Asset               (images: png/jpg/webp)
  PATCH  /api/projects/:slug/assets/:assetId PatchAssetBody -> Asset
  DELETE /api/projects/:slug/assets/:assetId           -> Project
  POST   /api/projects/:slug/stages/:stage RunStageBody -> JobInfo            (409 if that stage is already running)
  POST   /api/projects/:slug/jobs/:jobId/cancel        -> JobInfo
  PUT    /api/projects/:slug/edit SaveEditBody         -> SaveEditResponse | 409 SaveEditConflict
  GET    /api/projects/:slug/events                    -> text/event-stream of ServerEvent
  GET    /media/:slug/*                                -> file from the project folder (Range requests supported)
*/
export type { Asset, Config };
