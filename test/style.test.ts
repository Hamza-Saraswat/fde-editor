import { describe, expect, it } from "vitest";
import { ConfigSchema, EditSchema, type Cut, type Edit } from "../src/core/schema.ts";
import { applyStyle, resolveStyle } from "../src/core/style.ts";

const cut = (id: string, start: number, end: number, over: Partial<Cut> = {}): Cut =>
  ({ id, clipId: "c1", start, end, reason: "filler", by: "auto", enabled: true, ...over });
const editOf = (cuts: Cut[], over: Partial<Edit> = {}): Edit =>
  ({ version: 1, clipOrder: ["c1"], cuts, takeGroups: [], overlays: [], chapters: [], intro: true, outro: true, ...over });
const config = ConfigSchema.parse({});
const on = (e: Edit) => e.cuts.filter((c) => c.enabled).map((c) => c.id);

describe("resolveStyle", () => {
  it("uses the channel defaults with this video's overrides on top", () => {
    expect(resolveStyle(config)).toMatchObject({ fillers: "natural", fillerMinMs: 400, minSegmentMs: 1200, jumpCuts: "soft", softFrames: 4, maxPauseMs: config.edit.maxPauseMs });
    expect(resolveStyle(config, editOf([], { style: { fillers: "all", maxPauseMs: 800 } }))).toMatchObject({ fillers: "all", maxPauseMs: 800, jumpCuts: "soft" });
    expect(resolveStyle(config, editOf([], { punchIn: true })).jumpCuts).toBe("punch-in"); // the old switch still works
  });
});

describe("per-video style overrides", () => {
  it("store only what was changed, so channel defaults still reach the video", () => {
    const e = EditSchema.parse({ version: 1, clipOrder: [], cuts: [], takeGroups: [], overlays: [], chapters: [], style: { fillers: "all" } });
    expect(e.style).toEqual({ fillers: "all" });
    const later = ConfigSchema.parse({ edit: { style: { minSegmentMs: 2000 } } }); // the channel default changes
    expect(resolveStyle(later, e)).toMatchObject({ fillers: "all", minSegmentMs: 2000 });
  });
});

describe("applyStyle", () => {
  // real v2 numbers: most filler cuts are short natural "uh"s (median 0.24 s); a few are stalls
  const fillers = [cut("short", 10, 10.24), cut("stall", 20, 20.7), cut("you-know", 30, 30.3, { by: "claude" })];

  it("natural keeps the short fillers of fluent speech and cuts only stalls", () => {
    const e = applyStyle(editOf(fillers), resolveStyle(config));
    expect(on(e)).toEqual(["stall"]);
  });

  it("all and keep do what they say, and switching back is reversible", () => {
    const all = applyStyle(editOf(fillers), { ...resolveStyle(config), fillers: "all" });
    expect(on(all)).toEqual(["short", "stall", "you-know"]);
    const keep = applyStyle(all, { ...resolveStyle(config), fillers: "keep" });
    expect(on(keep)).toEqual([]);
    expect(on(applyStyle(keep, { ...resolveStyle(config), fillers: "all" }))).toEqual(["short", "stall", "you-know"]);
  });

  it("never touches the user's cuts, pinned cuts, stutters or a filler nobody wanted cut", () => {
    const e = editOf([
      cut("user", 1, 1.1, { by: "user", reason: "user" }),
      cut("pinned", 3, 3.2, { pinned: true }), // the user turned this short one on by hand
      cut("stutter", 5, 5.15, { reason: "repeat", by: "claude" }),
      cut("restart", 7, 7.9, { reason: "false-start", by: "claude" }),
      cut("offered", 9, 9.8, { enabled: false }), // a voiced gap offered, off
    ]);
    expect(on(applyStyle(e, resolveStyle(config)))).toEqual(["user", "pinned", "stutter", "restart"]);
  });

  it("drops a filler cut that would leave a sliver of video between two jumps", () => {
    // a stutter at 5.0–5.4, then a stall 0.6 s later: the 0.6 s between them would flash by
    const e = editOf([cut("stutter", 5, 5.4, { reason: "stumble", by: "claude" }), cut("stall", 6, 6.6)]);
    expect(on(applyStyle(e, resolveStyle(config)))).toEqual(["stutter"]);
    expect(on(applyStyle(e, { ...resolveStyle(config), minSegmentMs: 0 }))).toEqual(["stutter", "stall"]);
  });

  it("is idempotent and returns the same object when nothing changes", () => {
    const once = applyStyle(editOf(fillers), resolveStyle(config));
    expect(applyStyle(once, resolveStyle(config))).toBe(once);
  });
});
