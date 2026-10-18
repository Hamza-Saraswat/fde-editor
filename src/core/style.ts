// Edit style: how hard the edit cuts, set per video (edit.style) over the channel defaults
// (fde-editor.config.json → edit.style). Applying it is deterministic and reversible: filler cuts are
// switched on or off by length from what the planner wanted, and a filler cut that would leave a sliver
// of video between two jumps is dropped so the jump disappears. Stutters, restarts, false starts, takes
// and the user's own decisions are never touched. Pure; shared by the plan, the listen-back and the UI.
import type { Config, Cut, Edit, EditStyle } from "./schema.ts";

export type Style = Omit<EditStyle, "maxPauseMs"> & { maxPauseMs: number };

/** The channel style with this video's overrides on top. */
export function resolveStyle(config: Config, edit?: Pick<Edit, "style" | "punchIn"> | null): Style {
  const own = Object.fromEntries(Object.entries(edit?.style ?? {}).filter(([, v]) => v !== undefined)) as Partial<EditStyle>;
  const style: Style = { ...config.edit.style, maxPauseMs: config.edit.maxPauseMs, ...own } as Style;
  if (edit?.punchIn && !edit.style?.jumpCuts) style.jumpCuts = "punch-in";
  return style;
}

/** Filler cuts the style decides: not the user's, not pinned by a click in the review screen. */
export const styleControls = (c: Cut) => c.reason === "filler" && c.by !== "user" && !c.pinned;

const len = (c: Cut) => c.end - c.start;

export function applyStyle(edit: Edit, style: Style): Edit {
  const allow = (c: Cut) => style.fillers === "all" || (style.fillers === "natural" && len(c) * 1000 >= style.fillerMinMs);
  // what the planner wanted is kept the first time, so changing the style can always be undone
  let cuts = edit.cuts.map((c) => {
    if (!styleControls(c)) return c;
    const wanted = c.wanted ?? c.enabled;
    return { ...c, wanted, enabled: wanted && allow(c) };
  });

  // a sliver of kept video between two cuts reads as a double jump: drop the shorter filler cut
  for (let pass = 0; pass < 200; pass++) {
    const on = cuts.filter((c) => c.enabled).sort((a, b) => a.clipId.localeCompare(b.clipId) || a.start - b.start);
    let dropped: string | null = null;
    for (let i = 1; i < on.length && !dropped; i++) {
      const a = on[i - 1]!, b = on[i]!;
      const gap = b.start - a.end;
      if (a.clipId !== b.clipId || gap <= 0 || gap * 1000 >= style.minSegmentMs) continue;
      const pick = [a, b].filter(styleControls).sort((x, y) => len(x) - len(y))[0];
      if (pick) dropped = pick.id;
    }
    if (!dropped) break;
    cuts = cuts.map((c) => (c.id === dropped ? { ...c, enabled: false } : c));
  }

  const changed = cuts.some((c, i) => c !== edit.cuts[i] && (c.enabled !== edit.cuts[i]!.enabled || c.wanted !== edit.cuts[i]!.wanted));
  return changed ? { ...edit, cuts } : edit;
}
