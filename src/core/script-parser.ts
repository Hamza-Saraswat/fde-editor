// Markdown script -> ScriptDoc (script.json).
//
// Script format (see test/fixtures/scripts/*.md):
//   # Title
//   …header / meta (ignored until the first ## heading)…
//   ## Section name (m:ss–m:ss)        -> Section, level 2 (time range stripped)
//   ### Sub-section                    -> Section, level 3
//   **SAY**                            -> following paragraphs are spoken, until the next
//                                         **SAY**, blockquote, heading or ---
//   > GFX: …  /  > GFX (OPTIONAL): …  /  > B-ROLL: …   -> edit cues (may continue on more > lines)
//   `[CONFIRM: …]` / `[VERIFY …]`      -> notes to self, never spoken; collected as cue flags
// "## Description…" and "## Before you record" sections (and their ### children) are not spoken
// and are dropped entirely.
import { normalizeWords } from "./normalize.ts";
import { ScriptDocSchema } from "./schema.ts";
import type { Cue, ScriptDoc, Section, Sentence } from "./schema.ts";

/** ## sections whose title starts with one of these (case-insensitive) are skipped with their children. */
const NON_SPOKEN_SECTIONS = ["description", "before you record"];

// ---------- inline cleanup ----------

// `[anything]` in backticks is an editorial note; bare [CONFIRM…]/[VERIFY…] are flags too.
const BACKTICK_NOTE = /`\s*\[([^\]`]*)\]\s*`/g;
const BARE_FLAG = /\[\s*((?:CONFIRM|VERIFY)\b[^\]]*)\]/gi;

/** Remove inline flags/notes, pushing their inner text (e.g. "VERIFY: latent.space/…") into `flags`. */
function stripFlags(text: string, flags?: string[]): string {
  const collect = (_: string, inner: string) => {
    const flag = inner.replace(/\s+/g, " ").trim();
    if (flag && flags) flags.push(flag);
    return " ";
  };
  return text.replace(BACKTICK_NOTE, collect).replace(BARE_FLAG, collect);
}

/** Strip markdown emphasis, inline code ticks and links, keeping the visible text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(?!\s)(.+?)(?<!\s)\*/g, "$1")
    .replace(/(^|[^\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1$2")
    .replace(/\*\*/g, "");
}

function tidySpaces(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([.,!?;:…])/g, "$1").trim();
}

/** Spoken text as it should be read: flags and notes removed, emphasis removed, whitespace collapsed. */
export function cleanSpokenText(text: string): string {
  return tidySpaces(stripInlineMarkdown(stripFlags(text)));
}

// ---------- sentence splitting ----------

// Never end a sentence, whatever follows.
const ALWAYS_ABBREV = new Set([
  "e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "cf", "approx", "ca", "fig", "eq", "viz",
]);
// End a sentence only when the next word is capitalised.
const MAYBE_ABBREV = new Set(["etc", "inc", "ltd", "co", "corp", "al"]);

const OPENERS = `"'“‘(\\[`;
const NEXT_LOWER = new RegExp(`^[${OPENERS}]*[a-z]`);
const NEXT_UPPER = new RegExp(`^[${OPENERS}]*[A-Z0-9]`);
const LEADING_OPENERS = new RegExp(`^[${OPENERS}]+`);

/**
 * Split one paragraph of spoken text into sentences. Terminal . ! ? (or an ellipsis), optionally
 * followed by closing quotes/brackets, then whitespace or end of text. Abbreviations ("e.g.", "vs.",
 * "Dr."), dotted acronyms before a lowercase word ("the U.S. government"), decimals ("3.5") and an
 * ellipsis or quoted exclamation that runs on in lowercase ("wait… what", '"Wow!" she said') do not split.
 */
export function splitSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  const re = /(\.{3,}|…+|[.!?]+)(["'”’)\]]*)(?=\s|$)/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    const rest = text.slice(end).trimStart();
    if (rest && !isBoundary(text.slice(start, m.index), m[1]!, m[2]!, rest)) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function isBoundary(before: string, terminal: string, closers: string, rest: string): boolean {
  const nextLower = NEXT_LOWER.test(rest);
  if (terminal.includes("…") || terminal.startsWith("...")) return NEXT_UPPER.test(rest) && !/^\d/.test(rest);
  if (/["'”’]/.test(closers) && nextLower) return false;
  if (terminal === "." && !closers) {
    const word = (before.match(/\S+$/)?.[0] ?? "").replace(LEADING_OPENERS, "").toLowerCase();
    if (ALWAYS_ABBREV.has(word)) return false;
    const dottedAcronym = /^(?:[a-z]\.)+[a-z]$/.test(word); // u.s, a.m
    if ((MAYBE_ABBREV.has(word) || dottedAcronym) && nextLower) return false;
  }
  return true;
}

// ---------- cues ----------

const CUE_START = /^(GFX|B[- ]?ROLL)\b/i;
const CUE_PREFIX = /^(GFX|B[- ]?ROLL)\s*(\(\s*OPTIONAL\s*\))?\s*:?\s*(\(\s*OPTIONAL\s*\)\s*)?/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const PHRASE_PATTERNS = [
  /\b(?:when|as|once)\s+you\s+say\s+["“]([^"”]+)["”]/i,
  /\b(?:when|as|once)\s+you\s+say\s+['‘](.+?)['’](?=[\s,.;:!?)]|$)/i,
];
const HOLD_SECTION = /\bthrough(?:out)?\s+(?:the\s+)?(?:whole\s+|entire\s+|rest\s+of\s+(?:the\s+|this\s+)?)?(?:this\s+)?section\b|\b(?:whole|entire)\s+section\b|\brest\s+of\s+(?:the|this)\s+section\b/i;

type PendingCue = { lines: string[]; sectionId: string; afterSentenceId: string | null };

function buildCue(pending: PendingCue, counters: { gfx: number; broll: number }): Cue | null {
  const flags: string[] = [];
  // Rebuild the cue as lines: list items (and lines after an empty "> ") start a new line,
  // anything else is a soft wrap of the previous line.
  const lines: string[] = [];
  let newLine = true;
  for (const raw of pending.lines) {
    const line = stripFlags(raw, flags);
    if (!line.trim()) {
      newLine = true;
      continue;
    }
    if (newLine || LIST_ITEM.test(line) || lines.length === 0) lines.push(line);
    else lines[lines.length - 1] += ` ${line}`;
    newLine = false;
  }
  const cleaned = lines.map((l) => tidySpaces(stripInlineMarkdown(l))).filter(Boolean);
  const first = cleaned[0];
  const prefix = first?.match(CUE_PREFIX);
  if (!first || !prefix) return null;
  const kind = /^GFX$/i.test(prefix[1]!) ? "gfx" : "broll";
  const optional = Boolean(prefix[2] || prefix[3]);
  cleaned[0] = first.slice(prefix[0].length).trim();
  const text = cleaned.filter(Boolean).join("\n");

  let phrase: string | undefined;
  for (const re of PHRASE_PATTERNS) {
    const m = text.match(re);
    const p = m?.[1]?.replace(/[\s,.;:!?…]+$/, "").trim();
    if (p) {
      phrase = p;
      break;
    }
  }

  const id = kind === "gfx" ? `g${++counters.gfx}` : `r${++counters.broll}`;
  return {
    id,
    kind,
    optional,
    text,
    flags,
    sectionId: pending.sectionId,
    afterSentenceId: pending.afterSentenceId,
    ...(phrase ? { phrase } : {}),
    holdSection: HOLD_SECTION.test(text),
  };
}

// ---------- document ----------

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SAY_MARKER = /^\s*\*\*\s*SAY\s*:?\s*\*\*\s*:?\s*(.*)$/i;
const TIME_RANGE = /\s*\(\s*\d+(?::\d{2}){1,2}\s*[–—-]\s*\d+(?::\d{2}){1,2}\s*\)\s*$/;

function sectionTitle(raw: string): string {
  return tidySpaces(stripInlineMarkdown(raw)).replace(TIME_RANGE, "").trim();
}

/**
 * Undo markdown backslash escapes (`\$6.5B`, `\[VERIFY]`): editors that export markdown escape every
 * `$`, `[` and `*`, which would otherwise leak into spoken text, cue briefs and chapter titles, and hide
 * `[VERIFY …]` notes from the flag patterns.
 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

export function parseScript(markdown: string): ScriptDoc {
  const lines = unescapeMarkdown(markdown.replace(/\r\n?/g, "\n")).split("\n");
  let title = "";
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  const cues: Cue[] = [];
  const cueCounters = { gfx: 0, broll: 0 };

  let section: Section | null = null; // null before the first ## and inside skipped sections
  let sectionIndex = -1;
  let skipping = false;
  let inSay = false;
  let blockN = 0; // SAY blocks in the current section
  let sentenceN = 0; // sentences in the current section
  let blockId = "";
  let lastSentenceId: string | null = null;
  let para: string[] = [];
  let pendingCue: PendingCue | null = null;

  const flushPara = () => {
    if (para.length && inSay && section) {
      for (const text of splitSentences(cleanSpokenText(para.join(" ")))) {
        const tokens = normalizeWords(text);
        if (tokens.length === 0) continue;
        const id = `s${sectionIndex}.${++sentenceN}`;
        sentences.push({ id, sectionId: section.id, blockId, text, tokens });
        section.sentenceIds.push(id);
        lastSentenceId = id;
      }
    }
    para = [];
  };
  const flushCue = () => {
    if (pendingCue) {
      const cue = buildCue(pendingCue, cueCounters);
      if (cue) cues.push(cue);
    }
    pendingCue = null;
  };
  const endBlock = () => {
    flushPara();
    flushCue();
    inSay = false;
  };
  const openSection = (rawTitle: string, level: number): Section => {
    sectionIndex += 1;
    blockN = 0;
    sentenceN = 0;
    const next: Section = { id: `sec${sectionIndex}`, title: sectionTitle(rawTitle), level, sentenceIds: [] };
    sections.push(next);
    return next;
  };

  for (const line of lines) {
    const heading = line.match(HEADING);
    if (heading) {
      endBlock();
      const level = heading[1]!.length;
      const text = heading[2]!;
      if (level === 1) {
        if (!title) title = tidySpaces(stripInlineMarkdown(text));
      } else if (level === 2) {
        const name = sectionTitle(text).toLowerCase();
        skipping = NON_SPOKEN_SECTIONS.some((p) => name.startsWith(p));
        section = skipping ? null : openSection(text, 2);
      } else if (level === 3 && !skipping && sectionIndex >= 0) {
        section = openSection(text, 3);
      }
      continue;
    }
    if (!section) continue; // header/meta or a skipped section

    if (RULE.test(line)) {
      endBlock();
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara();
      inSay = false;
      const content = quote[1]!;
      if (CUE_START.test(stripInlineMarkdown(stripFlags(content)).trimStart())) {
        flushCue();
        pendingCue = { lines: [content], sectionId: section.id, afterSentenceId: lastSentenceId };
      } else if (pendingCue) {
        pendingCue.lines.push(content);
      }
      continue;
    }
    flushCue(); // a cue ends at the first line that isn't part of the blockquote

    const say = line.match(SAY_MARKER);
    if (say) {
      flushPara();
      inSay = true;
      blockId = `b${sectionIndex}.${++blockN}`;
      if (say[1]!.trim()) para.push(say[1]!);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (!inSay) continue;
    if (LIST_ITEM.test(line)) {
      flushPara();
      para.push(line.replace(LIST_ITEM, ""));
      continue;
    }
    para.push(line);
  }
  endBlock();

  return ScriptDocSchema.parse({ title, sections, sentences, cues });
}
