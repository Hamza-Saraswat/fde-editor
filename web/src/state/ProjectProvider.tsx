// Loads a project, keeps it live over SSE, and saves the edit (debounced, versioned).
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { EditConflictError, type StageRunOptions } from "../api.ts";
import type { Edit, PatchProjectBody, SetStyleBody, StageName } from "../types.ts";
import { useApp } from "./app.tsx";
import { initialProjectState, isDirty, projectReducer, type ProjectAction, type ProjectState, type Selection } from "./projectStore.ts";
import { fillerWordIds, indexWords, readingOrder, wordStatuses, type WordIndex, type WordStatus } from "../lib/words.ts";
import { wordOutputTimes, type WordTime } from "../lib/timemap.ts";
import { placeOverlays, segmentJoins, type Join, type Placement } from "../lib/placement.ts";

export const SAVE_DEBOUNCE_MS = 600;

type ProjectApi = {
  slug: string;
  state: ProjectState;
  dispatch: (a: ProjectAction) => void;
  edit: Edit | null; // the local edit (history.present)
  dirty: boolean;
  apply: (fn: (e: Edit) => Edit, key?: string) => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  refresh: () => Promise<void>;
  saveNow: () => void;
  runStage: (stage: StageName, options?: StageRunOptions) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  patchProject: (body: PatchProjectBody) => Promise<void>;
  setStyle: (style: SetStyleBody["style"]) => Promise<void>;
  notify: (text: string, tone?: "info" | "warn" | "error") => void;
};

export type Derived = {
  idx: WordIndex | null; // transcript words in playback order
  statuses: Map<string, WordStatus>;
  fillerIds: Set<string>;
  wordTimes: WordTime[]; // output times of the words that play
  placements: Placement[];
  joins: Join[];
  fps: number;
  duration: number;
};

const ProjectCtx = createContext<ProjectApi | null>(null);
const DerivedCtx = createContext<Derived | null>(null);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const { client, config } = useApp();
  const [state, dispatch] = useReducer(projectReducer, initialProjectState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [saveTick, setSaveTick] = useState(0);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      dispatch({ type: "loaded", bundle: await client.bundle(slug) });
    } catch (e) {
      dispatch({ type: "loadError", message: message(e) });
    }
  }, [client, slug]);

  // initial load + live events
  useEffect(() => {
    void refresh();
    let timer = 0;
    let wasOpen = false;
    const unsub = client.subscribe(
      slug,
      (e) => {
        dispatch({ type: "event", event: e });
        if (e.type === "bundle-changed" || (e.type === "job" && e.job.state !== "running")) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => void refresh(), 150);
        }
      },
      (st) => {
        dispatch({ type: "connection", state: st });
        if (st === "open" && wasOpen) void refresh(); // reconnected: catch up on anything missed
        if (st === "open") wasOpen = true;
      },
    );
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [client, slug, refresh]);

  const save = useCallback(async () => {
    const s = stateRef.current;
    if (inflight.current || !s.history || !isDirty(s)) return;
    inflight.current = true;
    const sent = s.history.present;
    dispatch({ type: "saveStart" });
    try {
      const resp = await client.saveEdit(slug, { ...sent, version: s.serverVersion });
      dispatch({ type: "saveOk", sent, resp });
    } catch (e) {
      if (e instanceof EditConflictError) {
        dispatch({ type: "conflict", current: e.current });
        void refresh();
      } else dispatch({ type: "saveError", message: message(e) });
    } finally {
      inflight.current = false;
      setSaveTick((t) => t + 1); // edits made during the save get their own save
    }
  }, [client, slug, refresh]);

  const present = state.history?.present;
  useEffect(() => {
    if (!state.history || !isDirty(state)) return;
    const t = window.setTimeout(() => void save(), state.saveError ? 4000 : SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [present, state.saved, state.saveError, saveTick, save]);

  // leaving the project (Back to projects) flushes a pending save instead of dropping it
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (isDirty(stateRef.current)) void saveRef.current();
    },
    [],
  );

  // warn before closing the tab with unsaved changes
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty(stateRef.current)) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const notify = useCallback((text: string, tone: "info" | "warn" | "error" = "info") => dispatch({ type: "notice", tone, text }), []);

  const api = useMemo<ProjectApi>(
    () => ({
      slug,
      state,
      dispatch,
      edit: state.history?.present ?? null,
      dirty: isDirty(state),
      apply: (fn, key) => dispatch({ type: "applyFn", fn, key }),
      undo: () => dispatch({ type: "history", action: { type: "undo" } }),
      redo: () => dispatch({ type: "history", action: { type: "redo" } }),
      select: (selection) => dispatch({ type: "select", selection }),
      refresh,
      saveNow: () => void save(),
      runStage: async (stage, options) => {
        try {
          const job = await client.runStage(slug, stage, options);
          dispatch({ type: "jobStarted", job });
        } catch (e) {
          notify(message(e), "error");
        }
      },
      cancelJob: async (jobId) => {
        try {
          await client.cancelJob(slug, jobId);
        } catch (e) {
          notify(message(e), "error");
        }
      },
      patchProject: async (body) => {
        try {
          dispatch({ type: "project", project: await client.patchProject(slug, body) });
        } catch (e) {
          notify(message(e), "error");
        }
      },
      // the server re-applies the style to the cuts: save pending edits first, then load its copy
      setStyle: async (style) => {
        try {
          await save();
          await client.setStyle(slug, style);
          await refresh();
        } catch (e) {
          notify(message(e), "error");
        }
      },
      notify,
    }),
    [slug, state, client, refresh, save, notify],
  );

  // ---------- derived views, recomputed only when their inputs change ----------
  const b = state.bundle;
  const edit = state.history?.present ?? null;
  const fps = b?.timeline?.fps ?? config?.output.fps ?? 30;
  const idx = useMemo(() => (b?.transcript ? indexWords(readingOrder(b.transcript, edit?.clipOrder ?? b.edit?.clipOrder)) : null), [b?.transcript, edit?.clipOrder, b?.edit?.clipOrder]);
  const statuses = useMemo(() => (idx && edit ? wordStatuses(idx, edit) : new Map<string, WordStatus>()), [idx, edit]);
  const fillerIds = useMemo(() => (b?.transcript ? fillerWordIds(b.transcript) : new Set<string>()), [b?.transcript]);
  const wordTimes = useMemo(() => (idx && b?.timeline ? wordOutputTimes(b.timeline, idx.order) : []), [idx, b?.timeline]);
  const placements = useMemo(
    () => (idx && edit ? placeOverlays(edit, b?.timeline ?? null, state.basis, idx, wordTimes) : []),
    [idx, edit, b?.timeline, state.basis, wordTimes],
  );
  const joins = useMemo(() => (idx && edit && b?.timeline ? segmentJoins(b.timeline, edit, idx) : []), [idx, edit, b?.timeline]);
  const derived = useMemo<Derived>(
    () => ({ idx, statuses, fillerIds, wordTimes, placements, joins, fps, duration: b?.timeline?.duration ?? 0 }),
    [idx, statuses, fillerIds, wordTimes, placements, joins, fps, b?.timeline?.duration],
  );

  return (
    <ProjectCtx.Provider value={api}>
      <DerivedCtx.Provider value={derived}>{children}</DerivedCtx.Provider>
    </ProjectCtx.Provider>
  );
}

export function useProject(): ProjectApi {
  const v = useContext(ProjectCtx);
  if (!v) throw new Error("useProject outside ProjectProvider");
  return v;
}

export function useDerived(): Derived {
  const v = useContext(DerivedCtx);
  if (!v) throw new Error("useDerived outside ProjectProvider");
  return v;
}
