// A realistic fake project for ?mock=1: the cold open and section 1 of
// test/fixtures/scripts/01-what-is-an-ai-engineer.md, recorded in two clips with fillers, a false
// start, a stumble, a repeat, two ad-libs, and two retaken lines.
import type {
  Asset, Candidates, Clip, Cue, Cut, Edit, FillerCandidate, GraphicStatus, Overlay, Project, ScriptDoc, Section, Sentence,
  TakeGroup, Transcript, Word,
} from "../types.ts";

// ---------- script ----------

type SecDef = { title: string; level: number; sentences: string[] };
const SECTIONS: SecDef[] = [
  {
    title: "Cold open",
    level: 2,
    sentences: [
      "Search \"AI engineer\" on LinkedIn right now, and you'll find two completely different jobs using the same title.",
      "One wants a developer who uses AI to write code faster.",
      "The other wants someone who can walk into a company, figure out where AI actually helps, and build it.",
      "Same title.",
      "Different job.",
      "And if you're trying to break into this field, chasing the wrong one is a great way to waste six months.",
      "So in this video: what an AI engineer actually is, the two kinds of job postings you'll run into, the skills you need for each, the mindset that matters more than any of them, and how to start building without spending a fortune.",
      "I'm Hamza.",
      "I build production AI systems for internal teams at a software company.",
      "Let's get into it.",
    ],
  },
  {
    title: "1. What an AI engineer is",
    level: 2,
    sentences: [
      "The simple version first.",
      "An AI engineer builds software on top of AI models that somebody else trained.",
      "You're not training GPT or Claude.",
      "That's machine learning research, and it's a different job with a different path.",
      "An AI engineer takes a model through an API and turns it into something that does real work.",
      "A bot that answers questions from your company's docs.",
      "An agent that sorts a support inbox.",
      "A workflow that reads invoices and flags the weird ones.",
      "The term really took off in 2023, when swyx wrote an essay called \"The Rise of the AI Engineer.\"",
      "His point was that the models had turned into an API call.",
      "You didn't need a research background to build with them anymore, and a new kind of engineer was showing up to do exactly that.",
      "That's the clean definition.",
      "Now go read the actual job postings, and it gets messy.",
    ],
  },
  {
    title: "2. The two job postings",
    level: 2,
    sentences: [
      "I've been reading a lot of these postings, and getting a lot of recruiter messages, and almost every one lands in one of two buckets.",
    ],
  },
  {
    title: "Type 1: the AI-powered developer",
    level: 3,
    sentences: [
      "The first type is a software engineer who uses AI to build.",
      "The job is shipping product code: front end, back end, full stack.",
      "The \"AI\" part is that they expect you to work with tools like Claude Code, Codex, or Cursor, and move a lot faster because of it.",
    ],
  },
  {
    title: "Type 2: the applied AI engineer",
    level: 3,
    sentences: ["The second type is a different animal.", "These postings want you to build AI into the business."],
  },
];

const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

function buildScript(): ScriptDoc {
  const sections: Section[] = [];
  const sentences: Sentence[] = [];
  SECTIONS.forEach((def, si) => {
    const ids = def.sentences.map((_, i) => `s${si}.${i + 1}`);
    sections.push({ id: `sec${si}`, title: def.title, level: def.level, sentenceIds: ids });
    def.sentences.forEach((text, i) => sentences.push({ id: ids[i]!, sectionId: `sec${si}`, blockId: `b${si}.1`, text, tokens: tokens(text) }));
  });
  const cues: Cue[] = [
    {
      id: "g1", kind: "gfx", optional: false, sectionId: "sec0", afterSentenceId: "s0.6", holdSection: false, flags: [],
      text: "two job cards slide in side by side, both titled \"AI Engineer.\" Card A highlights Copilot · Claude · Node.js. Card B highlights RAG · agents · cross-functional.",
    },
    {
      id: "g2", kind: "gfx", optional: false, sectionId: "sec1", afterSentenceId: "s1.8", holdSection: false, flags: [],
      text: "three-layer stack builds bottom-up. Bottom: The model (trained by OpenAI, Anthropic, Google…). Middle, highlighted: The AI engineer builds here. Top: The product people actually use.",
    },
    {
      id: "g3", kind: "gfx", optional: false, sectionId: "sec1", afterSentenceId: "s1.11", holdSection: false,
      flags: ["VERIFY: latent.space/p/ai-engineer"],
      text: "card with the essay title and \"swyx · Latent Space · 2023\"",
    },
    {
      id: "r1", kind: "broll", optional: false, sectionId: "sec3", afterSentenceId: "s3.2", holdSection: false, flags: [],
      text: "the Mid-Level AI Developer posting pops in on the open side. Highlight \"AI-assisted development tools,\" \"AI coding assistants,\" and the stack bullets. Crop out the header with location, contract length, and interview format.",
    },
    {
      id: "g4", kind: "gfx", optional: true, sectionId: "sec4", afterSentenceId: "s4.2", holdSection: false, flags: ["VERIFY before using"],
      text: "\"FDE job postings on Indeed: 643 (Apr 2025) → 5,330 (Apr 2026).\" Source line: Indeed data via Business Insider.",
    },
  ];
  return { title: "What Is an AI Engineer? (It's Actually Two Different Jobs)", sections, sentences, cues };
}

// ---------- the recording ----------

type Take = { tag: string; clipId: string; words: Word[]; start: number; end: number };

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

class Recorder {
  words: Word[] = [];
  fillers: FillerCandidate[] = [];
  silences: { clipId: string; start: number; end: number }[] = [];
  takes: Take[] = [];
  clipEnds = new Map<string, number>();
  private t = 0;
  private clip = "";
  private r = rng(7);

  startClip(clipId: string) {
    if (this.clip) this.clipEnds.set(this.clip, this.t + 0.8);
    this.clip = clipId;
    this.t = 0.72;
  }

  say(tag: string, text: string): Take {
    const out: Word[] = [];
    const parts = text.split(/\s+/).filter(Boolean);
    const start = this.t;
    for (const raw of parts) {
      const letters = raw.replace(/[^A-Za-z0-9]/g, "").length;
      const filler = /^(um|uh)[,.]?$/i.test(raw);
      const dur = filler ? 0.3 + this.r() * 0.16 : (0.1 + 0.05 * letters) * (0.85 + this.r() * 0.3);
      const w: Word = { id: `w${this.words.length}`, clipId: this.clip, text: raw, start: round(this.t), end: round(this.t + dur) };
      this.words.push(w);
      out.push(w);
      if (filler) this.fillers.push({ id: `f${this.fillers.length}`, clipId: this.clip, start: w.start, end: w.end, kind: "token", wordId: w.id });
      this.t += dur;
      this.t += /[.?!]$/.test(raw) ? 0.36 + this.r() * 0.18 : /[,:]$/.test(raw) ? 0.15 + this.r() * 0.1 : 0.02 + this.r() * 0.05;
    }
    const take: Take = { tag, clipId: this.clip, words: out, start, end: out.at(-1)!.end };
    this.takes.push(take);
    return take;
  }

  /** A silent pause. */
  pause(sec: number) {
    const span = { clipId: this.clip, start: round(this.t), end: round(this.t + sec) };
    this.silences.push(span);
    this.t += sec;
    return span;
  }

  /** A voiced gap with no word: an "um" the transcriber dropped. */
  gap(sec: number) {
    const after = this.words.at(-1)!;
    const f: FillerCandidate = { id: `f${this.fillers.length}`, clipId: this.clip, start: round(this.t), end: round(this.t + sec), kind: "gap", afterWordId: after.id };
    this.fillers.push(f);
    this.t += sec + 0.05;
    return f;
  }

  finish() {
    this.clipEnds.set(this.clip, this.t + 0.8);
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export type MockFixture = {
  project: Project;
  script: ScriptDoc;
  transcript: Transcript;
  candidates: Candidates;
  edit: Edit;
  graphics: Record<string, GraphicStatus>;
};

export function buildMockFixture(slug: string): MockFixture {
  const script = buildScript();
  const rec = new Recorder();
  let cutN = 0;
  const cuts: Cut[] = [];
  const cut = (c: Omit<Cut, "id">) => {
    const x: Cut = { id: `k${++cutN}`, ...c };
    cuts.push(x);
    return x;
  };
  const wordsCut = (t: Take, from: number, to: number, reason: Cut["reason"], by: Cut["by"], enabled = true, note?: string) =>
    cut({ clipId: t.clipId, start: t.words[from]!.start, end: t.words[to]!.end, reason, by, enabled, ...(note ? { note } : {}) });

  // clip 1: cold open
  rec.startClip("c1");
  const s01 = rec.say("s0.1", "Search AI engineer on LinkedIn right now, and um, you'll find two completely different jobs using the same title.");
  wordsCut(s01, 8, 8, "filler", "auto");
  rec.pause(0.9);
  const a1 = rec.say("s0.2#1", "One wants a uh developer who uses AI to to write code faster.");
  const ad1 = rec.say("adlib1", "Hold on, let me do that again.");
  cut({ clipId: "c1", start: ad1.start, end: ad1.end, reason: "adlib", by: "claude", enabled: true, note: "Talking to yourself between takes." });
  const p1 = rec.pause(1.4);
  cut({ clipId: "c1", start: p1.start, end: p1.end, reason: "silence", by: "auto", enabled: true });
  const a2 = rec.say("s0.2#2", "One wants a developer who uses AI to write code faster.");
  const s03 = rec.say("s0.3", "The other wants someone who can walk into a company, figure out where AI actually helps, and build it.");
  const g1 = rec.gap(0.55);
  cut({ clipId: "c1", start: g1.start, end: g1.end, reason: "filler", by: "auto", enabled: true, note: "Voiced gap: probably an \"um\"." });
  rec.say("s0.4", "Same title.");
  const s05 = rec.say("s0.5", "Different job.");
  rec.say("s0.6", "And if you're trying to break into this field, chasing the wrong one is a great way to waste six months.");
  const p2 = rec.pause(2.1);
  cut({ clipId: "c1", start: p2.start, end: p2.end, reason: "silence", by: "auto", enabled: true });
  const s07 = rec.say(
    "s0.7",
    "So in this so in this video, what an AI engineer actually is, the two kinds of job postings you'll run into, the skills you need for each, the mindset that matters more than any of them, and how to start building without spending a fortune.",
  );
  wordsCut(s07, 0, 2, "false-start", "claude");
  rec.say("s0.8", "I'm Hamza.");
  rec.say("s0.9", "I build production AI systems for internal teams at a software company.");
  const s010 = rec.say("s0.10", "Let's get into it.");

  // clip 2: section 1 and the start of section 2
  rec.startClip("c2");
  const s11 = rec.say("s1.1", "The simple version first.");
  const b1 = rec.say("s1.2#1", "An AI engineer builds software on top of, um, models that");
  rec.pause(0.8);
  const b2 = rec.say("s1.2#2", "An AI engineer builds software on top of AI models that somebody else trained.");
  const b3 = rec.say("s1.2#3", "An AI engineer builds software on top of AI models that, uh, somebody else trained.");
  rec.say("s1.3", "You're not training GPT or Claude.");
  const s14 = rec.say("s1.4", "That's machine learning research, and it's a different, a different job with a different path.");
  wordsCut(s14, 6, 7, "repeat", "claude");
  const ad2 = rec.say("adlib2", "Honestly, that surprised me when I started.");
  cut({ clipId: "c2", start: ad2.start, end: ad2.end, reason: "adlib", by: "claude", enabled: false, note: "Natural aside; it keeps the tone personal." });
  const s15 = rec.say("s1.5", "An AI engineer takes a model through an API and turns it into something that does real work.");
  rec.say("s1.6", "A bot that answers questions from your company's docs.");
  const s17 = rec.say("s1.7", "An agent that sorts a, a support inbox.");
  wordsCut(s17, 4, 4, "stumble", "claude");
  const s18 = rec.say("s1.8", "A workflow that reads invoices and flags the weird ones.");
  const p3 = rec.pause(1.2);
  cut({ clipId: "c2", start: p3.start, end: p3.end, reason: "silence", by: "auto", enabled: true });
  const s112 = rec.say("s1.12", "That's the clean definition.");
  const s113 = rec.say("s1.13", "Now go read the actual job postings, and it gets messy.");
  const s21 = rec.say("s2.1", "I've been reading a lot of these postings, and, uh, getting a lot of recruiter messages, and almost every one lands in one of two buckets.");
  wordsCut(s21, 9, 9, "filler", "auto", false);
  const s31 = rec.say("s3.1", "The first type is a software engineer who uses AI to build.");
  const s32 = rec.say("s3.2", "The job is shipping product code: front end, back end, full stack.");
  rec.finish();

  // your own cut: "actually" in s0.3
  cuts.push({ id: "u1", clipId: "c1", start: s03.words[14]!.start, end: s03.words[14]!.end, reason: "user", by: "user", enabled: true });

  const transcript: Transcript = { engine: "local-parakeet", model: "parakeet-tdt-0.6b-v3", words: rec.words, silences: rec.silences, fillers: rec.fillers };

  // ---------- aligner output ----------

  const takesFor = (sid: string) => rec.takes.filter((t) => t.tag === sid || t.tag.startsWith(`${sid}#`));
  const occ = (t: Take, score: number) => ({ clipId: t.clipId, startWordId: t.words[0]!.id, endWordId: t.words.at(-1)!.id, score });
  const candidates: Candidates = {
    sentences: script.sentences.map((s) => {
      const ts = takesFor(s.id);
      const scores = s.id === "s1.2" ? [0.62, 1, 0.93] : s.id === "s0.2" ? [0.86, 1] : ts.map(() => 0.96);
      return { sentenceId: s.id, occurrences: ts.map((t, i) => occ(t, scores[i] ?? 0.9)), chosen: ts.length ? (ts.length > 1 ? 1 : 0) : null };
    }),
    adlibs: [ad1, ad2].map((t) => ({ clipId: t.clipId, startWordId: t.words[0]!.id, endWordId: t.words.at(-1)!.id })),
    missing: script.sentences.filter((s) => !takesFor(s.id).length).map((s) => s.id),
  };

  // ---------- Claude's plan, compiled ----------

  const opt = (t: Take) => ({ clipId: t.clipId, startWordId: t.words[0]!.id, endWordId: t.words.at(-1)!.id, start: t.start, end: t.end });
  const takeGroups: TakeGroup[] = [];
  for (const s of script.sentences) {
    const ts = takesFor(s.id);
    if (!ts.length) continue;
    let why = "Only take.";
    if (s.id === "s0.2") why = "Take 2 is clean. Take 1 has an \"uh\" and a doubled \"to\".";
    if (s.id === "s1.2") why = "Take 2 is the only complete, clean read. Take 1 breaks off after \"models that\"; take 3 has an \"uh\" before \"somebody\".";
    takeGroups.push({ id: `tg${takeGroups.length + 1}`, sentenceIds: [s.id], options: ts.map(opt), chosen: ts.length > 1 ? 1 : 0, why });
  }

  const first = (t: Take) => t.words[0]!.id;
  const last = (t: Take) => t.words.at(-1)!.id;
  const overlays: Overlay[] = [
    {
      id: "o-g1", cueId: "g1", enabled: true, anchorWordId: first(a2), endWordId: last(s05), offsetMs: 0, layout: "split", assetIds: [],
      brief: "Two job cards slide in from the edges, one on each side of Hamza, both titled \"AI Engineer\". Left card (blue tint): chips for Copilot, Claude, Node.js. Right card (orange tint): RAG, agents, cross-functional. Cards land on \"One wants\" and \"The other wants\"; hold through \"Different job.\"",
    },
    {
      id: "o-g2", cueId: "g2", enabled: true, anchorWordId: first(s15), endWordId: last(s18), offsetMs: 0, layout: "side", side: "right", assetIds: [],
      brief: "Three-layer stack builds bottom-up on the right: \"The model\" (OpenAI, Anthropic, Google…), then the highlighted middle layer \"The AI engineer builds here\", then \"The product people actually use\". One layer per example sentence.",
    },
    {
      id: "o-g3", cueId: "g3", enabled: false, anchorWordId: first(s112), endWordId: last(s113), offsetMs: 0, layout: "full", assetIds: [],
      brief: "Full-frame essay card: \"The Rise of the AI Engineer\", swyx, Latent Space, 2023. The essay lines weren't recorded, so this sits on \"That's the clean definition.\" Off until you decide.",
    },
    {
      id: "o-r1", cueId: "r1", enabled: true, anchorWordId: first(s31), endWordId: last(s32), offsetMs: 200, layout: "side", side: "left", assetIds: ["a1"],
      brief: "Job-post screenshot pops in on the left. Use the crop (header with location and contract length removed), blur the recruiter line, highlight the two AI-tool bullets.",
    },
  ];

  const edit: Edit = {
    version: 3,
    clipOrder: ["c1", "c2"],
    cuts,
    takeGroups,
    overlays,
    chapters: [
      { title: "Two jobs, one title", anchorWordId: first(s01) },
      { title: "What an AI engineer is", anchorWordId: first(s11) },
      { title: "The two job postings", anchorWordId: first(s21) },
    ],
    intro: true,
    outro: true,
  };
  void s010;

  const clip = (id: string, name: string): Clip => ({
    id, name, path: `/Users/hamzasaraswat/Downloads/${name}`, duration: round(rec.clipEnds.get(id) ?? 60), width: 2560, height: 1440, fps: 30,
    codec: "h264", pixFmt: "yuv444p", hasAudio: true, vfr: false, hdr: false,
  });

  const asset: Asset = {
    id: "a1", name: "mid-level-ai-developer.png", file: "assets/a1-mid-level-ai-developer.png", kind: "image", width: 1200, height: 1500, cueId: "r1",
    crop: { x: 0, y: 0.16, w: 1, h: 0.84 },
    blur: [{ x: 0.05, y: 0.86, w: 0.7, h: 0.035 }],
    highlight: [{ x: 0.05, y: 0.37, w: 0.88, h: 0.058 }, { x: 0.05, y: 0.46, w: 0.88, h: 0.058 }],
  };

  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const project: Project = {
    slug,
    title: script.title,
    createdAt: ago(60 * 26),
    scriptSource: "/Users/hamzasaraswat/Documents/Projects/FDE_Channel/01-what-is-an-ai-engineer/youtube-script.md",
    speakerSide: "center",
    nextVideoTitle: "Workflows vs. agents: the most mixed-up idea in AI",
    clips: [clip("c1", "Untitled video - 30 Sept 2026.mp4"), clip("c2", "Untitled video - 30 Sept 2026 (2).mp4")],
    assets: [asset],
    stages: {
      import: { state: "done", message: "2 clips, 2 proxies", updatedAt: ago(60 * 26) },
      transcribe: { state: "done", message: `Parakeet, ${rec.words.length} words`, updatedAt: ago(60 * 25) },
      align: { state: "done", message: `${script.sentences.length - candidates.missing.length} of ${script.sentences.length} lines found, 2 retakes`, updatedAt: ago(60 * 25) },
      plan: { state: "done", message: `${cuts.length} cuts, 4 graphics placed`, updatedAt: ago(60 * 24) },
      graphics: { state: "running", message: "Building g2", progress: 0.55, updatedAt: ago(1) },
      preview: { state: "done", message: "Preview ready", updatedAt: ago(30) },
      render: { state: "idle", message: "" },
      xclips: { state: "idle", message: "" },
    },
  };

  const graphics: Record<string, GraphicStatus> = {
    g1: { cueId: "g1", state: "ready", message: "Built", updatedAt: ago(40), durationSec: 9.4, layout: "split", still: mockStill("g1", "split", "right"), hasMov: true, stale: false },
    g2: { cueId: "g2", state: "rendering", message: "Rendering ProRes 4444, frame 96 of 210", updatedAt: ago(1), durationSec: 7.6, layout: "side", side: "right", hasMov: false, stale: false },
    g3: { cueId: "g3", state: "error", message: "lint: text overflows the safe area in .card-title (3 issues)", updatedAt: ago(35), layout: "full", hasMov: false, stale: false },
    r1: { cueId: "r1", state: "none", message: "Not built yet", hasMov: false, stale: false },
  };

  return { project, script, transcript, candidates, edit, graphics };
}

// ---------- fake media (data URLs) ----------

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const CARD_TEXT: Record<string, [string, string[]]> = {
  g1: ["AI Engineer", ["Copilot", "Claude", "Node.js"]],
  g2: ["The AI engineer builds here", ["The product people use", "The model"]],
  g3: ["The Rise of the AI Engineer", ["swyx", "Latent Space", "2023"]],
  r1: ["Mid-Level AI Developer", ["AI-assisted development tools", "AI coding assistants"]],
};

/** A transparent 16:9 still like the graphics job's snapshot: a card on the open side. */
export function mockStill(cueId: string, layout: "side" | "split" | "full", side: "left" | "right"): string {
  const [title, chips] = CARD_TEXT[cueId] ?? [cueId.toUpperCase(), ["Graphic"]];
  const card = (x: number, w: number, tint: string, t: string, items: string[]) => `
    <g transform="translate(${x} 170)">
      <rect width="${w}" height="560" rx="28" fill="#15181a" fill-opacity="0.92" stroke="${tint}" stroke-width="4"/>
      <rect x="40" y="48" width="120" height="10" rx="5" fill="${tint}"/>
      <text x="40" y="140" font-family="-apple-system, Helvetica, sans-serif" font-size="54" font-weight="700" fill="#f3efe8">${esc(t)}</text>
      ${items.map((c, i) => `<g transform="translate(40 ${210 + i * 96})"><rect width="${Math.min(w - 80, 120 + c.length * 22)}" height="68" rx="34" fill="${tint}" fill-opacity="0.18"/><text x="30" y="45" font-family="-apple-system, Helvetica, sans-serif" font-size="32" fill="#f3efe8">${esc(c)}</text></g>`).join("")}
    </g>`;
  let body = "";
  if (layout === "split") body = card(70, 520, "#6f9fd8", title, chips) + card(1010, 520, "#E8501A", title, ["RAG", "agents", "cross-functional"]);
  else if (layout === "full") body = `<rect width="1600" height="900" fill="#101314" fill-opacity="0.94"/>${card(330, 940, "#E8501A", title, chips)}`;
  else body = card(side === "left" ? 70 : 760, 770, "#E8501A", title, chips);
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900">${body}</svg>`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A plain job-post screenshot (fictional company) for the B-roll box editor. */
export function mockPostingImage(): string {
  const line = (y: number, w: number, c = "#c9ccd1") => `<rect x="72" y="${y}" width="${w}" height="16" rx="8" fill="${c}"/>`;
  const text = (y: number, s: string, size = 30, weight = 400, fill = "#1f2328") =>
    `<text x="72" y="${y}" font-family="-apple-system, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" width="1200" height="1500">
    <rect width="1200" height="1500" fill="#ffffff"/>
    <rect width="1200" height="230" fill="#eef1f5"/>
    ${text(90, "Northwind Staffing · Contract, 12 months", 28, 500, "#57606a")}
    ${text(140, "City, TX (hybrid) · 3 interview rounds", 28, 400, "#57606a")}
    ${text(320, "Mid-Level AI Developer", 54, 700)}
    ${text(380, "Responsibilities", 30, 600, "#57606a")}
    ${text(585, "• Developing enterprise custom applications using", 32)}
    ${text(625, "   AI-assisted development tools", 32)}
    ${text(720, "• Demonstrated experience using AI coding assistants,", 32)}
    ${text(760, "   like GitHub Copilot, Claude, or Cursor", 32)}
    ${text(860, "• JavaScript, TypeScript, Node, SQL", 32)}
    ${line(930, 900)}${line(970, 760)}${line(1010, 820)}
    ${text(1100, "• Hands-on experience building agentic agents,", 32)}
    ${text(1140, "   including tool use and function calling", 32)}
    ${text(1325, "Recruiter: Jordan Example, jordan@example.com", 28, 400, "#57606a")}
  </svg>`);
}
