// Where things sit in output time: overlay blocks (with unsaved nudges applied) and the joins
// between A-roll segments (where cuts happened). Pure.
import type { CutReason, Edit, Overlay, Project, Timeline } from "../types.ts";
import type { WordIndex } from "./words.ts";
import { optionWords } from "./words.ts";
import type { WordTime } from "./timemap.ts";

/** Same rule as the server: an explicit side wins, else the open side of a speaker on a third. */
export function overlaySide(o: Pick<Overlay, "side">, speakerSide: Project["speakerSide"]): "left" | "right" {
  if (o.side) return o.side;
  return speakerSide === "right" ? "left" : "right";
}

export type Placement = {
  overlayId: string;
  cueId: string;
  start: number; // output seconds
  end: number;
  enabled: boolean;
  estimated: boolean; // computed in the browser (unsaved change, or not placed by the server)
};

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/**
 * Overlay blocks in output time.
 * Saved overlays use the server's placement; unsaved nudges/lengths shift it by the difference from
 * `basis` (the edit the timeline was derived from). Disabled or unplaced overlays are estimated from
 * their words' output times, following cut words forward (anchor) or backward (end).
 */
export function placeOverlays(
  edit: Edit,
  timeline: Timeline | null,
  basis: Edit | null,
  idx: WordIndex,
  times: WordTime[],
): Placement[] {
  if (!timeline) return [];
  const timeById = new Map(times.map((t) => [t.id, t]));
  const resolve = (wordId: string, dir: 1 | -1): WordTime | null => {
    let p = idx.pos.get(wordId);
    if (p === undefined) return null;
    for (; p >= 0 && p < idx.order.length; p += dir) {
      const t = timeById.get(idx.order[p]!.id);
      if (t) return t;
    }
    return null;
  };
  const dur = timeline.duration;
  const out: Placement[] = [];
  for (const ov of edit.overlays) {
    const placed = timeline.overlays.find((p) => p.overlayId === ov.id);
    const base = basis?.overlays.find((o) => o.id === ov.id);
    const sameWords = base && base.anchorWordId === ov.anchorWordId && base.endWordId === ov.endWordId;
    if (placed && base && sameWords && ov.enabled) {
      const shift = ((ov.offsetMs ?? 0) - (base.offsetMs ?? 0)) / 1000;
      const start = placed.start + shift;
      // A nudge moves the whole graphic (same rule as the server's timeline).
      let end = placed.end + shift;
      if (ov.durMs != null) end = start + ov.durMs / 1000;
      else if (base.durMs != null) end = (resolve(ov.endWordId, -1)?.end ?? placed.end) + (ov.offsetMs ?? 0) / 1000;
      const estimated = (ov.offsetMs ?? 0) !== (base.offsetMs ?? 0) || ov.durMs !== base.durMs;
      out.push({ overlayId: ov.id, cueId: ov.cueId, start: clamp(start, 0, dur), end: clamp(end, 0, dur), enabled: true, estimated });
      continue;
    }
    const a = resolve(ov.anchorWordId, 1);
    if (!a) continue;
    const start = a.start + (ov.offsetMs ?? 0) / 1000;
    const endWord = resolve(ov.endWordId, -1)?.end;
    const end = ov.durMs != null ? start + ov.durMs / 1000 : endWord === undefined ? undefined : endWord + (ov.offsetMs ?? 0) / 1000;
    if (end === undefined || end - start < 0.05) continue;
    out.push({ overlayId: ov.id, cueId: ov.cueId, start: clamp(start, 0, dur), end: clamp(end, 0, dur), enabled: ov.enabled, estimated: true });
  }
  return out.sort((x, y) => x.start - y.start);
}

export type Join = {
  t: number; // output time of the join
  clipChange: boolean; // next segment comes from another clip
  removed: number; // source seconds removed here (0 at a clip change)
  reasons: (CutReason | "take" | "pause")[];
  cutIds: string[];
  groupIds: string[];
};

/** One entry per join between consecutive segments, explaining what was removed there. */
export function segmentJoins(timeline: Timeline, edit: Edit, idx: WordIndex): Join[] {
  const joins: Join[] = [];
  const segs = timeline.segments;
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1]!;
    const b = segs[i]!;
    if (a.clipId !== b.clipId) {
      joins.push({ t: b.outStart, clipChange: true, removed: 0, reasons: [], cutIds: [], groupIds: [] });
      continue;
    }
    const gap = { start: a.end, end: b.start };
    const hit = (s: number, e: number) => s < gap.end - 1e-6 && e > gap.start + 1e-6;
    const cuts = edit.cuts.filter((c) => c.enabled && c.clipId === a.clipId && hit(c.start, c.end));
    const groups = edit.takeGroups.filter((g) =>
      g.options.some((o, k) => {
        if (k === g.chosen || o.clipId !== a.clipId) return false;
        const ws = optionWords(idx, o);
        return ws.length ? hit(ws[0]!.start, ws.at(-1)!.end) : hit(o.start, o.end);
      }),
    );
    const reasons: Join["reasons"] = [...new Set<CutReason | "take">([...groups.map(() => "take" as const), ...cuts.map((c) => c.reason)])];
    if (!reasons.length) reasons.push("pause");
    joins.push({
      t: b.outStart,
      clipChange: false,
      removed: Math.max(0, gap.end - gap.start),
      reasons,
      cutIds: cuts.map((c) => c.id),
      groupIds: groups.map((g) => g.id),
    });
  }
  return joins;
}
