import { describe, expect, it } from "vitest";
import type { Timeline, Word } from "../src/core/schema.ts";
import { chapterTime, chaptersText, srtFromTimeline, srtTime, wrapCaption } from "../src/media/sidecars.ts";

describe("chaptersText", () => {
  const chapters = [
    { title: "Hook", start: 0 },
    { title: "What the job is", start: 42.7 },
    { title: "The two flavours", start: 130 },
    { title: "How to get hired", start: 615 },
  ];

  it("formats m:ss, one per line, first at 0:00", () => {
    expect(chaptersText(chapters, 0)).toBe("0:00 Hook\n0:42 What the job is\n2:10 The two flavours\n10:15 How to get hired");
  });

  it("shifts by the intro and pulls the first chapter to 0:00", () => {
    expect(chaptersText(chapters, 5.5)).toBe("0:00 Hook\n0:48 What the job is\n2:15 The two flavours\n10:20 How to get hired");
    const late = [{ title: "Start", start: 3 }, ...chapters.slice(1)];
    expect(chaptersText(late, 0).split("\n")[0]).toBe("0:00 Start");
  });

  it("drops chapters closer than 10 s to the previous one", () => {
    const tight = [
      { title: "A", start: 0 },
      { title: "too soon", start: 9.9 },
      { title: "B", start: 10 },
      { title: "C", start: 25 },
      { title: "also too soon", start: 30 },
      { title: "D", start: 40 },
    ];
    expect(chaptersText(tight, 0)).toBe("0:00 A\n0:10 B\n0:25 C\n0:40 D");
    // with an intro the first chapter at 0:00 absorbs one that lands within 10 s of it
    expect(chaptersText([{ title: "A", start: 2 }, { title: "B", start: 5 }, { title: "C", start: 30 }, { title: "D", start: 60 }], 3))
      .toBe("0:00 A\n0:33 C\n1:03 D");
  });

  it("drops a last chapter shorter than 10 s when the total length is known", () => {
    const list = [...chapters, { title: "Bye", start: 700 }];
    expect(chaptersText(list, 0, 705)).not.toContain("Bye");
    expect(chaptersText(list, 0, 720)).toContain("11:40 Bye");
  });

  it("needs at least 3 chapters", () => {
    expect(chaptersText(chapters.slice(0, 2), 0)).toBe("");
    expect(chaptersText([{ title: "A", start: 0 }, { title: "B", start: 5 }, { title: "C", start: 8 }], 0)).toBe("");
    expect(chaptersText([], 0)).toBe("");
  });

  it("uses h:mm:ss past an hour", () => {
    expect(chapterTime(3725.9)).toBe("1:02:05");
    expect(chapterTime(59.99)).toBe("0:59");
    expect(chaptersText([...chapters, { title: "Long tail", start: 3700 }], 0).split("\n").at(-1)).toBe("1:01:40 Long tail");
  });
});

describe("srtFromTimeline", () => {
  let n = 0;
  const w = (text: string, start: number, end: number, clipId = "c1"): Word => ({ id: `w${n++}`, clipId, text, start, end });

  // keep c1 [0, 3) and [5, 8); c2 [1, 3) — output 0–3, 3–6, 6–8
  const timeline: Timeline = {
    fps: 30,
    segments: [
      { clipId: "c1", start: 0, end: 3, frames: 90, outStart: 0 },
      { clipId: "c1", start: 5, end: 8, frames: 90, outStart: 3 },
      { clipId: "c2", start: 1, end: 3, frames: 60, outStart: 6 },
    ],
    duration: 8,
    overlays: [],
    chapters: [],
  };

  it("SRT timestamps", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(3725.5)).toBe("01:02:05,500");
    expect(srtTime(1.0006)).toBe("00:00:01,001");
  });

  it("maps kept words through the timeline, drops cut words and fillers, shifts by the intro", () => {
    n = 0;
    const words = [
      w("Hello", 0.2, 0.5),
      w("um,", 0.6, 0.8), // filler
      w("world.", 0.9, 1.3),
      w("cut", 3.5, 3.9), // inside the removed 3–5 s
      w("Second", 5.1, 5.5), // -> 3.1–3.5
      w("take", 5.6, 5.9),
      w("from", 1.2, 1.4, "c2"), // -> 6.2–6.4
      w("clip", 1.5, 1.8, "c2"),
      w("two.", 1.9, 2.2, "c2"),
    ];
    const srt = srtFromTimeline(words, timeline, 2);
    expect(srt).toBe([
      "1\n00:00:02,200 --> 00:00:03,300\nHello world.\n",
      "2\n00:00:05,100 --> 00:00:05,900\nSecond take\n",
      "3\n00:00:08,200 --> 00:00:09,200\nfrom clip two.\n",
    ].join("\n"));
    expect(srt).not.toContain("um");
    expect(srt).not.toContain("cut");
  });

  it("a word is kept when its midpoint is inside a segment, and is clamped to it", () => {
    n = 0;
    const srt = srtFromTimeline([w("edge", 2.8, 3.1), w("gone", 2.9, 3.4)], timeline, 0, undefined, { minCueSeconds: 0 });
    expect(srt).toBe("1\n00:00:02,800 --> 00:00:03,000\nedge\n");
  });

  it("prefers the script spelling", () => {
    n = 0;
    const words = [w("we", 0.1, 0.3), w("use", 0.3, 0.5), w("cloud", 0.5, 0.8), w("code", 0.8, 1.0), w("twenty", 1.0, 1.2), w("twenty", 1.2, 1.4), w("six", 1.4, 1.6)];
    const script = new Map([["w2", "Claude"], ["w3", "Code"], ["w4", "2026."], ["w5", ""], ["w6", ""]]);
    const srt = srtFromTimeline(words, timeline, 0, script);
    expect(srt).toBe("1\n00:00:00,100 --> 00:00:01,600\nwe use Claude Code 2026.\n");
  });

  it("splits at pauses > 0.6 s, keeps cues ≤ 6 s and ≤ 2 lines of 42 chars", () => {
    n = 0;
    const long: Timeline = { fps: 30, segments: [{ clipId: "c1", start: 0, end: 60, frames: 1800, outStart: 0 }], duration: 60, overlays: [], chapters: [] };
    // pause split
    const paused = srtFromTimeline([w("before", 0, 0.4), w("after", 1.1, 1.5)], long, 0);
    expect(paused.split("\n\n").length).toBe(2);
    // a continuous run of short words: no cue longer than 6 s, no line over 42 chars, ≤ 2 lines
    n = 0;
    const words = Array.from({ length: 60 }, (_, i) => w(`word${i}`, i * 0.3, i * 0.3 + 0.25));
    const srt = srtFromTimeline(words, long, 0);
    const cues = srt.trim().split("\n\n").map((block) => block.split("\n"));
    expect(cues.length).toBeGreaterThan(3);
    for (const [, time, ...lines] of cues) {
      const [a, b] = time!.split(" --> ").map((t) => {
        const [h, m, rest] = t.split(":");
        return Number(h) * 3600 + Number(m) * 60 + Number(rest!.replace(",", "."));
      });
      expect(b! - a!).toBeLessThanOrEqual(6);
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    }
    // every word made it through, in order
    expect(cues.flatMap(([, , ...l]) => l.join(" ").split(" "))).toEqual(words.map((x) => x.text));
  });

  it("breaks after sentence punctuation", () => {
    n = 0;
    const srt = srtFromTimeline([w("Done.", 0, 0.3), w("Next", 0.35, 0.6), w("one?", 0.6, 0.9), w("Yes", 0.95, 1.2)], timeline, 0, undefined, { minCueSeconds: 0 });
    expect(srt.split("\n\n").map((b) => b.split("\n").slice(2).join(" ").trim())).toEqual(["Done.", "Next one?", "Yes"]);
  });

  it("wrapCaption balances two lines", () => {
    expect(wrapCaption("short line")).toEqual(["short line"]);
    expect(wrapCaption("this caption is a bit too long to fit on a single line")).toEqual(["this caption is a bit too", "long to fit on a single line"]);
    expect(wrapCaption("x".repeat(30) + " " + "y".repeat(30) + " " + "z".repeat(30))).toBeNull();
  });
});
