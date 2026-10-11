import { describe, expect, it } from "vitest";
import { zonesFor } from "../src/graphics/index.ts";
import { captionsHtml, groupCaptions } from "../src/graphics/captions.ts";
import { overlaySide } from "../src/core/schema.ts";

describe("zonesFor", () => {
  it("puts side graphics in the open side when the speaker is on a third", () => {
    expect(zonesFor("left", "side", "right")).toEqual(["right-wide"]);
    expect(zonesFor("right", "side", "left")).toEqual(["left-wide"]);
  });
  it("uses the chosen side when the speaker is centred", () => {
    expect(zonesFor("center", "side", "left")).toEqual(["left-narrow"]);
    expect(zonesFor("center", "side", "right")).toEqual(["right-narrow"]);
  });
  it("splits across both sides only when centred", () => {
    expect(zonesFor("center", "split", "left")).toEqual(["left-narrow", "right-narrow"]);
    expect(zonesFor("left", "split", "right")).toEqual(["right-wide"]);
  });
  it("full layout fills the frame regardless of framing", () => {
    expect(zonesFor("center", "full", "left")).toEqual(["full"]);
  });
});

describe("overlaySide", () => {
  it("defaults to the open side and respects an explicit side", () => {
    expect(overlaySide({}, "left")).toBe("right");
    expect(overlaySide({}, "right")).toBe("left");
    expect(overlaySide({}, "center")).toBe("right");
    expect(overlaySide({ side: "left" }, "center")).toBe("left");
  });
});

describe("captions", () => {
  const words = (s: string, t0 = 0, step = 0.3) => s.split(" ").map((text, i) => ({ text, start: t0 + i * step, end: t0 + i * step + 0.25 }));

  it("groups into short phrases, breaking at punctuation and pauses, dropping fillers", () => {
    const cues = groupCaptions([...words("So um here's the thing, it works."), ...words("Next idea", 5)]);
    expect(cues.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["So here's the thing,", "it works.", "Next idea"]);
    expect(cues.every((c) => c.words.join(" ").length <= 200)).toBe(true);
  });

  it("holds a cue until the next one (≤ 0.6 s) and never overlaps", () => {
    const cues = groupCaptions(words("one two three. four five six."));
    for (let i = 0; i + 1 < cues.length; i++) expect(cues[i]!.end).toBeLessThanOrEqual(cues[i + 1]!.start + 1e-9);
  });

  it("keeps lines under the character limit", () => {
    const cues = groupCaptions(words("an extremely long run of words without any punctuation that keeps going and going"));
    for (const c of cues) expect(c.words.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(28 + 12);
  });

  it("writes a valid single-timeline composition with escaped text", () => {
    const html = captionsHtml(groupCaptions(words("Tom & <Jerry> rock.")), 3, 1920, 1080);
    expect(html).toContain('data-duration="3"');
    expect(html).toContain(">&amp;</span>");
    expect(html).toContain(">&lt;Jerry&gt;</span>");
    expect(html).not.toContain("<Jerry>");
    expect(html).toContain('window.__timelines["main"] = tl');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
