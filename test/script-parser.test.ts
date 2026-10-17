import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScriptDocSchema } from "../src/core/schema.ts";
import { parseScript, splitSentences } from "../src/core/script-parser.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/scripts/01-what-is-an-ai-engineer.md", import.meta.url));
const markdown = readFileSync(FIXTURE, "utf8");
const doc = parseScript(markdown);

// Cue lines as they appear in the fixture, counted straight from the file.
const cueLines = markdown.split("\n").filter((l) => /^>\s*(GFX|B-ROLL)\b/.test(l));
const gfxInFile = cueLines.filter((l) => /^>\s*GFX\b/.test(l)).length;
const brollInFile = cueLines.filter((l) => /^>\s*B-ROLL\b/.test(l)).length;

describe("parseScript on 01-what-is-an-ai-engineer.md", () => {
  it("validates against ScriptDocSchema", () => {
    expect(() => ScriptDocSchema.parse(doc)).not.toThrow();
  });

  it("reads the H1 title", () => {
    expect(doc.title).toBe("What Is an AI Engineer? (It's Actually Two Different Jobs)");
  });

  it("builds ## and ### sections with time ranges stripped", () => {
    expect(doc.sections.map((s) => [s.id, s.level, s.title])).toEqual([
      ["sec0", 2, "Cold open"],
      ["sec1", 2, "1. What an AI engineer is"],
      ["sec2", 2, "2. The two job postings"],
      ["sec3", 3, "Type 1: the AI-powered developer"],
      ["sec4", 3, "Type 2: the applied AI engineer"],
      ["sec5", 3, "How to tell them apart"],
      ["sec6", 2, "3. The skills"],
      ["sec7", 2, "4. The mindset shift"],
      ["sec8", 2, "5. You don't need a $200 plan"],
      ["sec9", 2, "6. Resources + close"],
    ]);
  });

  it("drops the Description and Before-you-record sections and everything in them", () => {
    const titles = doc.sections.map((s) => s.title.toLowerCase());
    expect(titles.some((t) => t.startsWith("description") || t.startsWith("before you record"))).toBe(false);
    const allText = [...doc.sentences.map((s) => s.text), ...doc.cues.map((c) => c.text)].join("\n");
    expect(allText).not.toContain("Companion article");
    expect(allText).not.toContain("Assets to gather");
    expect(allText).not.toContain("Fact-check list");
    expect(allText).not.toContain("HyperFrames comps");
    // nothing from the header/meta block either
    expect(allText).not.toContain("Title options");
    expect(allText).not.toContain("teleprompter");
  });

  it("finds every GFX and B-ROLL cue in the file", () => {
    const gfx = doc.cues.filter((c) => c.kind === "gfx");
    const broll = doc.cues.filter((c) => c.kind === "broll");
    expect(gfx.length).toBe(gfxInFile);
    expect(broll.length).toBe(brollInFile);
    expect(gfx.length).toBe(12);
    expect(broll.length).toBe(3);
    expect(gfx.filter((c) => c.optional).length).toBe(1);
    expect(broll.filter((c) => c.optional).length).toBe(0);
    expect(gfx.map((c) => c.id)).toEqual(gfx.map((_, i) => `g${i + 1}`));
    expect(broll.map((c) => c.id)).toEqual(broll.map((_, i) => `r${i + 1}`));
  });

  it("parses the OPTIONAL cue with a flag before the colon", () => {
    const optional = doc.cues.find((c) => c.optional)!;
    expect(optional.kind).toBe("gfx");
    expect(optional.flags).toEqual(["VERIFY before using"]);
    expect(optional.text.startsWith('"FDE job postings on Indeed')).toBe(true);
    expect(optional.sectionId).toBe("sec4");
  });

  it("captures the trigger phrase on the cheat-sheet cue", () => {
    const cue = doc.cues.find((c) => c.text.includes("cheat sheet"))!;
    expect(cue.id).toMatch(/^g\d+$/);
    expect(cue.phrase).toBe("cheat sheet");
    expect(doc.cues.filter((c) => c.phrase !== undefined)).toHaveLength(1);
  });

  it("marks the checklist cue as holding through its section", () => {
    const cue = doc.cues.find((c) => c.text.includes("checklist"))!;
    expect(cue.holdSection).toBe(true);
    expect(cue.sectionId).toBe("sec6");
    expect(doc.cues.filter((c) => c.holdSection)).toHaveLength(1);
  });

  it("keeps the price-ladder list lines in the cue text", () => {
    const cue = doc.cues.find((c) => c.text.startsWith("price ladder"))!;
    const lines = cue.text.split("\n");
    expect(lines).toContain("- OpenCode Go: ~$10/mo · open models (GLM, Kimi, Qwen…)");
    expect(lines).toHaveLength(6);
    expect(cue.flags).toEqual(["VERIFY all on record day"]);
    expect(cue.text).not.toContain("**");
  });

  it("moves inline flags out of cue text into flags", () => {
    const essay = doc.cues.find((c) => c.text.includes("essay title"))!;
    expect(essay.flags).toEqual(["VERIFY: latent.space/p/ai-engineer"]);
    for (const c of doc.cues) {
      expect(c.text).not.toMatch(/\[(CONFIRM|VERIFY)/);
      expect(c.text).not.toContain("`");
    }
  });

  it("keeps flags, notes and emphasis out of spoken sentences", () => {
    for (const s of doc.sentences) {
      expect(s.text).not.toContain("[CONFIRM");
      expect(s.text).not.toContain("[VERIFY");
      expect(s.text).not.toMatch(/[`*]/);
    }
    // the backticked publish-day note in "Resources + close" is not spoken either
    expect(doc.sentences.some((s) => s.text.includes("publish day"))).toBe(false);
    expect(doc.sentences.find((s) => s.text.startsWith("These postings want you"))!.text)
      .toBe("These postings want you to build AI into the business.");
  });

  it("points every cue at an existing sentence", () => {
    const ids = new Set(doc.sentences.map((s) => s.id));
    for (const c of doc.cues) {
      expect(c.afterSentenceId).not.toBeNull();
      expect(ids.has(c.afterSentenceId!)).toBe(true);
    }
  });

  it("anchors the first cue (two job cards) after 'waste six months.'", () => {
    const first = doc.cues[0]!;
    expect(first.id).toBe("g1");
    expect(first.text).toContain("two job cards");
    const anchor = doc.sentences.find((s) => s.id === first.afterSentenceId)!;
    expect(anchor.text.endsWith("waste six months.")).toBe(true);
    expect(anchor.id).toBe("s0.6");
  });

  it("numbers sentences and SAY blocks per section and lists them on the section", () => {
    for (const section of doc.sections) {
      const idx = section.id.slice(3);
      const own = doc.sentences.filter((s) => s.sectionId === section.id);
      expect(section.sentenceIds).toEqual(own.map((s) => s.id));
      expect(own.map((s) => s.id)).toEqual(own.map((_, i) => `s${idx}.${i + 1}`));
      for (const s of own) expect(s.blockId).toMatch(new RegExp(`^b${idx}\\.\\d+$`));
    }
    const coldOpen = doc.sentences.filter((s) => s.sectionId === "sec0");
    expect(new Set(coldOpen.map((s) => s.blockId))).toEqual(new Set(["b0.1", "b0.2"]));
  });

  it("splits quoted sentences in the posting excerpt", () => {
    const texts = doc.sentences.filter((s) => s.sectionId === "sec3").map((s) => s.text);
    expect(texts).toContain('"Developing enterprise custom applications using AI-assisted development tools."');
    expect(texts).toContain(
      '"Demonstrated experience using AI coding assistants, like GitHub Copilot, Claude, or Cursor, in a professional development environment."',
    );
  });

  it("has a spoken word count within 20% of the header's estimate", () => {
    const stated = Number(markdown.match(/~?([\d,]+)\s+spoken words/)![1]!.replace(/,/g, ""));
    expect(stated).toBe(1350);
    const words = doc.sentences.reduce((n, s) => n + s.tokens.length, 0);
    expect(words).toBeGreaterThanOrEqual(stated * 0.8);
    expect(words).toBeLessThanOrEqual(stated * 1.2);
  });

  it("stores normalized tokens on every sentence", () => {
    for (const s of doc.sentences) expect(s.tokens.length).toBeGreaterThan(0);
    const glm = doc.sentences.find((s) => s.text.includes("GLM 5.3"))!;
    expect(glm.tokens).toEqual(expect.arrayContaining(["glm", "five", "point", "three"]));
  });
});

describe("splitSentences", () => {
  it("does not split on abbreviations", () => {
    expect(splitSentences("Use a tool, e.g. Cursor or Codex. Then ship it.")).toEqual([
      "Use a tool, e.g. Cursor or Codex.",
      "Then ship it.",
    ]);
    expect(splitSentences("That is, i.e. the model. Python vs. TypeScript is fine.")).toEqual([
      "That is, i.e. the model.",
      "Python vs. TypeScript is fine.",
    ]);
    expect(splitSentences("Ask Dr. Smith and Mr. Jones. They know.")).toEqual([
      "Ask Dr. Smith and Mr. Jones.",
      "They know.",
    ]);
    expect(splitSentences("Prompts, evals, etc. are the basics. Learn them.")).toEqual([
      "Prompts, evals, etc. are the basics.",
      "Learn them.",
    ]);
  });

  it("does not split on decimals or dotted names", () => {
    expect(splitSentences("It runs GLM 5.3 on Z.ai for $3.50 a month. Cheap.")).toEqual([
      "It runs GLM 5.3 on Z.ai for $3.50 a month.",
      "Cheap.",
    ]);
  });

  it("splits after closing quotes and keeps the quote with its sentence", () => {
    expect(splitSentences('He wrote "The Rise of the AI Engineer." His point was simple.')).toEqual([
      'He wrote "The Rise of the AI Engineer."',
      "His point was simple.",
    ]);
    expect(splitSentences("They said “ship it!” And we did.")).toEqual([
      "They said “ship it!”",
      "And we did.",
    ]);
    expect(splitSentences('"Wow!" she said. Then she left.')).toEqual(['"Wow!" she said.', "Then she left."]);
  });

  it("handles ellipses", () => {
    expect(splitSentences("I thought… maybe not. Wait... What happened?")).toEqual([
      "I thought… maybe not.",
      "Wait...",
      "What happened?",
    ]);
  });

  it("splits on ! and ? and keeps a trailing fragment", () => {
    expect(splitSentences("Really? Yes! And then")).toEqual(["Really?", "Yes!", "And then"]);
  });
});

describe("parseScript on inline markdown", () => {
  const md = [
    "# Tiny *Test*",
    "",
    "Meta line that should be ignored. **SAY**",
    "",
    "## Intro (0:00–0:30)",
    "",
    "**SAY**",
    "",
    "Hello there, e.g. you. This costs 3.5 dollars. `[CONFIRM: price]`",
    "Same paragraph, *second* line. [VERIFY numbers]",
    "",
    "> GFX (OPTIONAL) `[VERIFY before using]`: \"A stat card.\" when you say 'big number', pop it.",
    "> stays up for the whole section",
    "",
    "Not spoken: no SAY marker after the cue.",
    "",
    "**SAY**",
    "",
    "Second block here.",
    "",
    "> B-ROLL: a screenshot `[CONFIRM]`",
    "",
    "## Before You Record",
    "",
    "**SAY**",
    "",
    "Never spoken.",
    "",
    "> GFX: never a cue",
  ].join("\n");
  const tiny = parseScript(md);

  it("parses sentences, blocks and ids", () => {
    expect(tiny.title).toBe("Tiny Test");
    expect(tiny.sections).toEqual([
      { id: "sec0", title: "Intro", level: 2, sentenceIds: ["s0.1", "s0.2", "s0.3", "s0.4"] },
    ]);
    expect(tiny.sentences.map((s) => [s.id, s.blockId, s.text])).toEqual([
      ["s0.1", "b0.1", "Hello there, e.g. you."],
      ["s0.2", "b0.1", "This costs 3.5 dollars."],
      ["s0.3", "b0.1", "Same paragraph, second line."],
      ["s0.4", "b0.2", "Second block here."],
    ]);
  });

  it("parses an OPTIONAL cue with a flag before the colon, phrase and hold", () => {
    expect(tiny.cues).toHaveLength(2);
    const [g1, r1] = tiny.cues;
    expect(g1).toEqual({
      id: "g1",
      kind: "gfx",
      optional: true,
      text: "\"A stat card.\" when you say 'big number', pop it. stays up for the whole section",
      flags: ["VERIFY before using"],
      sectionId: "sec0",
      afterSentenceId: "s0.3",
      phrase: "big number",
      holdSection: true,
    });
    expect(r1).toMatchObject({ id: "r1", kind: "broll", optional: false, text: "a screenshot", flags: ["CONFIRM"], afterSentenceId: "s0.4" });
  });

  it("gives a cue before any spoken sentence a null afterSentenceId", () => {
    const early = parseScript("# T\n\n## A\n\n> GFX: first thing\n\n**SAY**\n\nThen we talk.\n");
    expect(early.cues[0]!.afterSentenceId).toBeNull();
    expect(early.sentences.map((s) => s.id)).toEqual(["s0.1"]);
  });
});

describe("parseScript on exported markdown with backslash escapes", () => {
  // Video 1 Script v2 came out of an editor that escapes every $ and [
  const doc = parseScript([
    "# Video",
    "## 5. You don't need a \\$200 plan (9:45–10:40)",
    "**SAY**",
    "It costs \\$20 a month. And the cheaper coding plans. `\\[the RAG piece has to be live by publish day]`",
    "> GFX: salary card: \"Anthropic FDE, posted base: \\$280K–\\$320K.\" `\\[VERIFY on record day]`",
  ].join("\n"));

  it("removes the escapes from titles, spoken text and cue briefs", () => {
    expect(doc.sections[0]!.title).toBe("5. You don't need a $200 plan");
    expect(doc.sentences.map((s) => s.text)).toEqual(["It costs $20 a month.", "And the cheaper coding plans."]);
    expect(doc.cues[0]!.text).toBe('salary card: "Anthropic FDE, posted base: $280K–$320K."');
  });

  it("still treats escaped bracket notes as notes, not speech", () => {
    expect(doc.cues[0]!.flags).toEqual(["VERIFY on record day"]);
  });
});
