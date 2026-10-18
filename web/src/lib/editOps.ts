// Edit mutations the review screen makes. Pure: each returns a new Edit, or the same object when
// nothing changes (so history can skip no-ops and "dirty" is a reference check).
import type { Cut, Edit, Overlay, Word } from "../types.ts";
import { snapMs } from "./timelineMath.ts";

export const MIN_OVERLAY_MS = 500; // the timeline drops anything shorter

function mapCut(edit: Edit, cutId: string, fn: (c: Cut) => Cut): Edit {
  let changed = false;
  const cuts = edit.cuts.map((c) => {
    if (c.id !== cutId) return c;
    const next = fn(c);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...edit, cuts } : edit;
}

function mapOverlay(edit: Edit, overlayId: string, fn: (o: Overlay) => Overlay): Edit {
  let changed = false;
  const overlays = edit.overlays.map((o) => {
    if (o.id !== overlayId) return o;
    const next = fn(o);
    if (next !== o) changed = true;
    return next;
  });
  return changed ? { ...edit, overlays } : edit;
}

// ---------- cuts ----------

// A cut the user turns on or off by hand is pinned: the edit style never overrides it afterwards.
export const toggleCut = (edit: Edit, cutId: string): Edit => mapCut(edit, cutId, (c) => ({ ...c, enabled: !c.enabled, pinned: true }));

export const setCutEnabled = (edit: Edit, cutId: string, enabled: boolean): Edit =>
  mapCut(edit, cutId, (c) => (c.enabled === enabled ? c : { ...c, enabled, pinned: true }));

/** Next free id for a user cut: u1, u2 … */
export function nextUserCutId(edit: Edit): string {
  let n = 0;
  for (const c of edit.cuts) {
    const m = /^u(\d+)$/.exec(c.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `u${n + 1}`;
}

/**
 * Cut a run of words (in reading order). Words from different clips become one cut per clip.
 * The cut spans first-word start to last-word end; the compiler clamps padding against it.
 */
export function addUserCut(edit: Edit, words: Word[]): Edit {
  if (!words.length) return edit;
  const byClip = new Map<string, Word[]>();
  for (const w of words) byClip.set(w.clipId, [...(byClip.get(w.clipId) ?? []), w]);
  let next = edit;
  for (const [clipId, ws] of byClip) {
    const start = Math.min(...ws.map((w) => w.start));
    const end = Math.max(...ws.map((w) => w.end));
    if (end <= start) continue;
    const dup = next.cuts.find((c) => c.by === "user" && c.clipId === clipId && c.start === start && c.end === end);
    if (dup) {
      next = setCutEnabled(next, dup.id, true);
      continue;
    }
    const cut: Cut = { id: nextUserCutId(next), clipId, start, end, reason: "user", by: "user", enabled: true };
    next = { ...next, cuts: [...next.cuts, cut] };
  }
  return next;
}

/** Remove a cut the user made. Auto and Claude cuts can only be switched off, never deleted. */
export function deleteCut(edit: Edit, cutId: string): Edit {
  const cut = edit.cuts.find((c) => c.id === cutId);
  if (!cut || cut.by !== "user") return edit;
  return { ...edit, cuts: edit.cuts.filter((c) => c.id !== cutId) };
}

/** Switch every cut with this reason on or off. */
export function setReasonEnabled(edit: Edit, reason: Cut["reason"], enabled: boolean): Edit {
  let changed = false;
  const cuts = edit.cuts.map((c) => {
    if (c.reason !== reason || c.enabled === enabled) return c;
    changed = true;
    return { ...c, enabled, pinned: true };
  });
  return changed ? { ...edit, cuts } : edit;
}

// ---------- takes ----------

export function chooseTake(edit: Edit, groupId: string, index: number): Edit {
  let changed = false;
  const takeGroups = edit.takeGroups.map((g) => {
    if (g.id !== groupId || g.chosen === index || index < 0 || index >= g.options.length) return g;
    changed = true;
    return { ...g, chosen: index };
  });
  return changed ? { ...edit, takeGroups } : edit;
}

// ---------- overlays ----------

/** Set the nudge from the anchor word, snapped to whole frames. */
export const nudgeOverlay = (edit: Edit, overlayId: string, offsetMs: number, fps: number): Edit =>
  mapOverlay(edit, overlayId, (o) => {
    const v = snapMs(offsetMs, fps);
    return (o.offsetMs ?? 0) === v ? o : { ...o, offsetMs: v };
  });

/** Fix the overlay's length (snapped, at least MIN_OVERLAY_MS), or pass undefined to follow the end word again. */
export const setOverlayDuration = (edit: Edit, overlayId: string, durMs: number | undefined, fps: number): Edit =>
  mapOverlay(edit, overlayId, (o) => {
    if (durMs === undefined) {
      if (o.durMs === undefined) return o;
      const { durMs: _drop, ...rest } = o;
      return rest as Overlay;
    }
    const frame = 1000 / fps;
    const min = snapMs(Math.ceil(MIN_OVERLAY_MS / frame - 1e-9) * frame, fps); // shortest whole-frame length >= the minimum
    const snapped = Math.max(snapMs(durMs, fps), min);
    return o.durMs === snapped ? o : { ...o, durMs: snapped };
  });

/** Back to Claude's placement: no nudge, length follows the end word. */
export const resetOverlayTiming = (edit: Edit, overlayId: string): Edit =>
  mapOverlay(edit, overlayId, (o) => {
    if ((o.offsetMs ?? 0) === 0 && o.durMs === undefined) return o;
    const { durMs: _drop, ...rest } = o;
    return { ...(rest as Overlay), offsetMs: 0 };
  });

export type OverlayPatch = Partial<Pick<Overlay, "brief" | "layout" | "side" | "enabled" | "assetIds">>;

export const updateOverlay = (edit: Edit, overlayId: string, patch: OverlayPatch): Edit =>
  mapOverlay(edit, overlayId, (o) => {
    const keys = Object.keys(patch) as (keyof OverlayPatch)[];
    const same = keys.every((k) => JSON.stringify(o[k]) === JSON.stringify(patch[k]));
    if (same) return o;
    const next = { ...o, ...patch };
    if (patch.side === undefined && "side" in patch) delete next.side;
    return next;
  });

export const attachAsset = (edit: Edit, overlayId: string, assetId: string): Edit =>
  mapOverlay(edit, overlayId, (o) => (o.assetIds.includes(assetId) ? o : { ...o, assetIds: [...o.assetIds, assetId] }));

export const detachAsset = (edit: Edit, overlayId: string, assetId: string): Edit =>
  mapOverlay(edit, overlayId, (o) => (o.assetIds.includes(assetId) ? { ...o, assetIds: o.assetIds.filter((a) => a !== assetId) } : o));

/** True when two edits differ in what the A-roll keeps (cuts or takes), i.e. the preview needs rebuilding. */
export function arollChanged(a: Edit | null, b: Edit | null): boolean {
  if (!a || !b) return a !== b;
  const key = (e: Edit) =>
    JSON.stringify([e.clipOrder, e.cuts.map((c) => [c.clipId, c.start, c.end, c.enabled]), e.takeGroups.map((g) => g.chosen)]);
  return key(a) !== key(b);
}
