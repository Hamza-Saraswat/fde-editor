// Builds the committed end-to-end fixture in test/fixtures/e2e/:
//   script.md                     the Cold open + section 1 of video 1
//   take.mp3                      a fake "recording" spoken by macOS `say` with a flubbed line + retake,
//                                 ums/uhs, dead air, a skipped sentence and an ad-lib
//   transcript-<engine>.json      raw word timings from the local engines (Parakeet, Whisper medium.en)
// The e2e test pairs take.mp3 with a generated test-pattern video, so no real footage is committed.
// Run: pnpm fixture   (needs macOS `say`, ffmpeg, and the HyperFrames CLI models)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HYPERFRAMES_BIN, REPO_ROOT } from "../src/core/paths.ts";

const OUT = join(REPO_ROOT, "test/fixtures/e2e");
const TMP = join(OUT, ".tmp");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 1. Script excerpt: header + Cold open + section 1, exactly as written.
const full = readFileSync(join(REPO_ROOT, "test/fixtures/scripts/01-what-is-an-ai-engineer.md"), "utf8").split("\n");
const end = full.findIndex((l, i) => i > 20 && l.startsWith("## 2."));
writeFileSync(join(OUT, "script.md"), full.slice(0, end).join("\n").trimEnd() + "\n");

// 2. The take. [[slnc N]] = N ms of silence.
const take = [
  "[[slnc 1200]]",
  "Search AI engineer on LinkedIn right now, and you'll find two completely different jobs using the same title.",
  "[[slnc 350]] One wants a developer who uses AI to write code faster.",
  "[[slnc 300]] The other wants someone who can walk into a, uh, walk into a, [[slnc 400]] hmm, let me redo that. [[slnc 900]]",
  "The other wants someone who can walk into a company, figure out where AI actually helps, and build it.",
  "[[slnc 400]] Same title. Different job. And if you're trying to break into this field, um, [[slnc 300]] chasing the wrong one is a great way to waste six months.",
  "[[slnc 1800]]",
  "So in this video: what an AI engineer actually is, the two kinds of job postings you'll run into, the skills you need for each, the mindset that matters more than any of them, and how to start building without spending a fortune.",
  "[[slnc 400]] I'm Hamza. I build production AI systems for internal teams at a software company. Let's get into it.",
  "[[slnc 1300]]",
  "The simple version first. An AI engineer builds software on top of AI models that somebody else trained.",
  "[[slnc 350]] You're not training GPT or Claude.", // "That's machine learning research…" is skipped on purpose
  "[[slnc 350]] Honestly, this part trips up a lot of people, so, um, stick with me.", // ad-lib
  "[[slnc 350]] An AI engineer takes a model through an API and turns it into something that does real work.",
  "A bot that answers questions from your company's docs. An agent that sorts a support inbox. A workflow that reads invoices and flags the weird ones.",
  "[[slnc 500]] The term really took off in 2023, when swyx wrote an essay called The Rise of the AI Engineer.",
  "His point was that the models had turned into an API call. You didn't need a research background to build with them anymore, and a new kind of engineer was, uh, showing up to do exactly that.",
  "[[slnc 450]] That's the clean definition. Now go read the actual job postings, and it gets messy.",
  "[[slnc 1000]]",
].join(" ");
const aiff = join(TMP, "take.aiff");
execFileSync("say", ["-v", "Samantha", "-r", "185", "-o", aiff, take]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", aiff, "-ac", "1", "-ar", "22050", "-c:a", "libmp3lame", "-b:a", "64k", join(OUT, "take.mp3")]);

// 3. Raw transcripts from the local engines (what transcripts/<engine>-<model>-c1.json caches).
const wav = join(TMP, "take.16k.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(OUT, "take.mp3"), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" };
for (const [name, args] of [
  ["parakeet", ["--engine", "parakeet"]],
  ["whisper-medium.en", ["--engine", "whisper", "--model", "medium.en"]],
] as const) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  execFileSync(HYPERFRAMES_BIN, ["transcribe", wav, "-d", dir, "--json", "--language", "en", ...args], { env, stdio: "ignore" });
  copyFileSync(join(dir, "transcript.json"), join(OUT, `transcript-${name}.json`));
  const words = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as unknown[];
  console.log(`${name}: ${words.length} words`);
}
rmSync(TMP, { recursive: true, force: true });
console.log("fixture written to", OUT);
