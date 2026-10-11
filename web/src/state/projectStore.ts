// The project screen's state: the server bundle, the local edit with undo/redo, save bookkeeping,
// selection, and the live log. Pure reducer; the provider (ProjectProvider.tsx) does the I/O.
import type { ConnectionState, StageRunOptions } from "../api.ts";
import type { ClaudeEvent, Edit, JobInfo, Project, ProjectBundle, SaveEditResponse, ServerEvent, StageName, Asset } from "../types.ts";
import { historyReducer, initHistory, type History, type HistoryAction } from "../lib/history.ts";
import { arollChanged } from "../lib/editOps.ts";

export type Selection =
  | { kind: "overlay"; id: string }
  | { kind: "cut"; id: string }
  | { kind: "take"; id: string }
  | { kind: "cue"; cueId: string }
  | { kind: "words"; anchor: string; focus: string }
  | null;

type LogInput = { stage: StageName } & (
  | { kind: "log"; line: string }
  | { kind: "claude"; cueId?: string; event: ClaudeEvent }
  | { kind: "job"; job: JobInfo }
);
export type LogEntry = LogInput & { id: number; at: number };

export type Notice = { id: number; tone: "info" | "warn" | "error"; text: string };

export type ProjectState = {
  bundle: ProjectBundle | null;
  loadError: string | null;
  history: History | null;
  serverVersion: number; // edit.version the server holds; sent with every save
  saved: Edit | null; // the history snapshot last confirmed by the server ("dirty" = present !== saved)
  basis: Edit | null; // the edit bundle.timeline was derived from
  saving: boolean;
  saveError: string | null;
  selection: Selection;
  logs: LogEntry[];
  unreadLogs: number;
  notice: Notice | null;
  previewNonce: number; // bumped when a preview job finishes: reloads the video
  previewStale: boolean; // the cut changed since the preview was built
  connection: ConnectionState;
  everConnected: boolean; // live updates have worked at least once (so "connecting" means reconnecting)
};

export const initialProjectState: ProjectState = {
  bundle: null,
  loadError: null,
  history: null,
  serverVersion: 0,
  saved: null,
  basis: null,
  saving: false,
  saveError: null,
  selection: null,
  logs: [],
  unreadLogs: 0,
  notice: null,
  previewNonce: 0,
  previewStale: false,
  connection: "connecting",
  everConnected: false,
};

export type ProjectAction =
  | { type: "loaded"; bundle: ProjectBundle }
  | { type: "loadError"; message: string }
  | { type: "history"; action: HistoryAction }
  | { type: "applyFn"; fn: (e: Edit) => Edit; key?: string }
  | { type: "saveStart" }
  | { type: "saveOk"; sent: Edit; resp: SaveEditResponse }
  | { type: "saveError"; message: string }
  | { type: "conflict"; current: Edit }
  | { type: "select"; selection: Selection }
  | { type: "event"; event: ServerEvent }
  | { type: "project"; project: Project }
  | { type: "asset"; asset: Asset }
  | { type: "notice"; tone: Notice["tone"]; text: string }
  | { type: "dismissNotice" }
  | { type: "connection"; state: ConnectionState }
  | { type: "logsSeen" }
  | { type: "clearLogs" }
  | { type: "jobStarted"; job: JobInfo };

const LOG_LIMIT = 3000;
let seq = 0;

export const isDirty = (s: Pick<ProjectState, "history" | "saved">) => !!s.history && s.history.present !== s.saved;

function upsertJob(jobs: JobInfo[], job: JobInfo): JobInfo[] {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i < 0) return [...jobs, job];
  const next = jobs.slice();
  next[i] = job;
  return next;
}

function pushLog(s: ProjectState, entry: LogInput, open = false): ProjectState {
  const logs: LogEntry[] = [...s.logs, { ...entry, id: ++seq, at: Date.now() }];
  return { ...s, logs: logs.length > LOG_LIMIT ? logs.slice(-LOG_LIMIT) : logs, unreadLogs: open ? 0 : s.unreadLogs + 1 };
}

export function projectReducer(s: ProjectState, a: ProjectAction): ProjectState {
  switch (a.type) {
    case "loaded": {
      const b = a.bundle;
      let { history, serverVersion, saved, basis } = s;
      if (!b.edit) {
        history = null;
        saved = null;
        basis = null;
        serverVersion = 0;
      } else if (!history || (!isDirty(s) && b.edit.version !== serverVersion)) {
        history = initHistory(b.edit); // a new server copy (first load, a re-plan): history starts over
        saved = b.edit;
        basis = b.edit;
        serverVersion = b.edit.version;
      } else if (b.edit.version === serverVersion) {
        basis = b.edit;
      }
      // dirty while the server moved on: keep local work; the next save gets a 409 and reloads
      return { ...s, bundle: b, loadError: null, history, serverVersion, saved, basis };
    }
    case "loadError":
      return { ...s, loadError: a.message };
    case "history":
      return s.history ? { ...s, history: historyReducer(s.history, a.action) } : s;
    case "applyFn": {
      if (!s.history) return s;
      const next = a.fn(s.history.present);
      if (next === s.history.present) return s;
      return { ...s, history: historyReducer(s.history, { type: "apply", edit: next, key: a.key }) };
    }
    case "saveStart":
      return { ...s, saving: true };
    case "saveOk": {
      const bundle = s.bundle ? { ...s.bundle, edit: a.resp.edit, timeline: a.resp.timeline } : s.bundle;
      return {
        ...s,
        bundle,
        saving: false,
        saveError: null,
        saved: a.sent,
        basis: a.resp.edit,
        serverVersion: a.resp.edit.version,
        previewStale: s.previewStale || arollChanged(s.basis, a.resp.edit),
      };
    }
    case "saveError":
      return { ...s, saving: false, saveError: a.message };
    case "conflict":
      return {
        ...s,
        saving: false,
        saveError: null,
        history: initHistory(a.current),
        saved: a.current,
        basis: null, // the timeline in hand is for the old edit; estimate until the reload lands
        serverVersion: a.current.version,
        notice: { id: ++seq, tone: "warn", text: "This edit was changed somewhere else (another tab, or a re-plan). Loaded the latest copy; your last unsaved changes were dropped." },
      };
    case "select":
      return { ...s, selection: a.selection };
    case "project":
      return s.bundle ? { ...s, bundle: { ...s.bundle, project: a.project } } : s;
    case "asset": {
      if (!s.bundle) return s;
      const assets = s.bundle.project.assets.some((x) => x.id === a.asset.id)
        ? s.bundle.project.assets.map((x) => (x.id === a.asset.id ? a.asset : x))
        : [...s.bundle.project.assets, a.asset];
      return { ...s, bundle: { ...s.bundle, project: { ...s.bundle.project, assets } } };
    }
    case "notice":
      return { ...s, notice: { id: ++seq, tone: a.tone, text: a.text } };
    case "dismissNotice":
      return { ...s, notice: null };
    case "connection":
      return { ...s, connection: a.state, everConnected: s.everConnected || a.state === "open" };
    case "logsSeen":
      return s.unreadLogs ? { ...s, unreadLogs: 0 } : s;
    case "clearLogs":
      return { ...s, logs: [], unreadLogs: 0 };
    case "jobStarted": {
      if (!s.bundle) return s;
      return { ...s, bundle: { ...s.bundle, jobs: upsertJob(s.bundle.jobs, a.job) } };
    }
    case "event":
      return applyEvent(s, a.event);
  }
}

function applyEvent(s: ProjectState, e: ServerEvent): ProjectState {
  const b = s.bundle;
  switch (e.type) {
    case "stage":
      if (!b) return s;
      return { ...s, bundle: { ...b, project: { ...b.project, stages: { ...b.project.stages, [e.stage]: e.status } } } };
    case "job": {
      if (!b) return s;
      const prev = b.jobs.find((j) => j.id === e.job.id);
      let next: ProjectState = { ...s, bundle: { ...b, jobs: upsertJob(b.jobs, e.job) } };
      if (!prev || prev.state !== e.job.state) next = pushLog(next, { kind: "job", stage: e.job.stage, job: e.job });
      if (e.job.stage === "preview" && e.job.state === "done" && prev?.state !== "done") {
        next = { ...next, previewNonce: next.previewNonce + 1, previewStale: false };
      }
      return next;
    }
    case "log":
      return pushLog(s, { kind: "log", stage: e.stage, line: e.line });
    case "claude":
      return pushLog(s, { kind: "claude", stage: e.stage, cueId: e.cueId, event: e.event });
    case "graphic":
      if (!b) return s;
      return { ...s, bundle: { ...b, graphics: { ...b.graphics, [e.status.cueId]: e.status } } };
    case "bundle-changed":
      return s; // the provider refetches
  }
}

/** Running job for a stage, if any. */
export const runningJob = (b: ProjectBundle | null, stage: StageName) =>
  b?.jobs.find((j) => j.stage === stage && j.state === "running") ?? null;

export type { StageRunOptions };
