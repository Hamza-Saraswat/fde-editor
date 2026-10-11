// Undo/redo over whole Edit snapshots. Pure reducer.
import type { Edit } from "../types.ts";

export const HISTORY_LIMIT = 200;
export const COALESCE_MS = 1200; // repeated changes with the same key inside this window are one undo step

export type History = {
  past: Edit[];
  present: Edit;
  future: Edit[];
  lastKey?: string; // coalescing key of the most recent apply
  lastAt?: number;
};

export type HistoryAction =
  | { type: "apply"; edit: Edit; key?: string; at?: number } // key: coalesce consecutive changes (typing in a field)
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; edit: Edit }; // load a server copy: clears history

export const initHistory = (edit: Edit): History => ({ past: [], present: edit, future: [] });

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "apply": {
      if (a.edit === h.present) return h;
      const at = a.at ?? Date.now();
      const coalesce = a.key !== undefined && a.key === h.lastKey && h.lastAt !== undefined && at - h.lastAt < COALESCE_MS && h.past.length > 0;
      const past = coalesce ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT);
      return { past, present: a.edit, future: [], lastKey: a.key, lastAt: at };
    }
    case "undo": {
      const prev = h.past.at(-1);
      if (!prev) return h;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    }
    case "redo": {
      const next = h.future[0];
      if (!next) return h;
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    }
    case "reset":
      return initHistory(a.edit);
  }
}

export const canUndo = (h: History | null) => !!h && h.past.length > 0;
export const canRedo = (h: History | null) => !!h && h.future.length > 0;
