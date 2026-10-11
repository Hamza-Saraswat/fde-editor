// Takes are stored with Claude's pick first; people think of them in the order they were recorded.
import type { TakeGroup } from "../types.ts";

const clipRank = (clipId: string) => Number(/(\d+)$/.exec(clipId)?.[1] ?? 0); // c1, c2 … are numbered in recording order

/** Option indices in recording order (earliest first). */
export function takesInRecordingOrder(group: Pick<TakeGroup, "options">): number[] {
  return group.options
    .map((o, i) => ({ i, clip: clipRank(o.clipId), start: o.start }))
    .sort((a, b) => a.clip - b.clip || a.start - b.start)
    .map((x) => x.i);
}

/** 1-based take number (recording order) of option `i`. */
export function takeNumber(group: Pick<TakeGroup, "options">, i: number): number {
  return takesInRecordingOrder(group).indexOf(i) + 1;
}
