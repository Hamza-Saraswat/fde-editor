// Round-trip check of cut quality on a real project: re-transcribe the EDITED preview audio and
// compare it with the words the edit kept. Clipped words show up as substitutions/deletions next
// to a cut; surviving fillers show up as filler tokens.
// Usage: tsx spikes/roundtrip.ts <slug>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HYPERFRAMES_BIN, projectPaths } from "../src/core/paths.ts";
import { EditSchema, TranscriptSchema } from "../src/core/schema.ts";
import { FILLER_WORDS, normalizeWords } from "../src/core/normalize.ts";
import { loadConfig, loadProject, readJson } from "../src/core/store.ts";
import { buildTimeline, keptWordIds, sourceToOutput } from "../src/core/timeline.ts";

const slug = process.argv[2]!;
const p = projectPaths(slug);
const work = join(p.cacheDir, "roundtrip");
mkdirSync(work, { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", p.preview, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", join(work, "edited.wav")]);
execFileSync(HYPERFRAMES_BIN, ["transcribe", join(work, "edited.wav"), "-d", work, "--json", "--engine", "parakeet", "--language", "en"], { env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" }, stdio: "ignore" });
const heard = JSON.parse(readFileSync(join(work, "transcript.json"), "utf8")) as { text: string; start: number; end: number }[];

const [edit, transcript, project, config] = [await readJson(p.edit, EditSchema), await readJson(p.transcript, TranscriptSchema), await loadProject(slug), await loadConfig()];
const tl = buildTimeline(edit, transcript, project.clips, config);
const kept = keptWordIds(edit, transcript);
const expected = transcript.words.filter((w) => kept.has(w.id));

const tok = (words: { text: string }[]) => words.flatMap((w) => normalizeWords(w.text)).filter((t) => !FILLER_WORDS.has(t));
const exp = tok(expected), got = tok(heard);
const fillersLeft = heard.filter((w) => normalizeWords(w.text).some((t) => FILLER_WORDS.has(t)));

// Levenshtein alignment with backtrace
const n = exp.length, m = got.length;
const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (exp[i - 1] === got[j - 1] ? 0 : 1));
const ops: string[] = [];
for (let i = n, j = m; i > 0 || j > 0;) {
  if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (exp[i - 1] === got[j - 1] ? 0 : 1)) { if (exp[i - 1] !== got[j - 1]) ops.push(`sub  "${exp[i - 1]}" → "${got[j - 1]}"`); i--; j--; }
  else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) { ops.push(`del  "${exp[i - 1]}"`); i--; }
  else { ops.push(`ins  "${got[j - 1]}"`); j--; }
}
ops.reverse();

// Word-onset safety: every kept word must start inside a segment (the bug the snapping fix addressed).
const clippedOnsets = expected.filter((w) => sourceToOutput(tl, w.clipId, w.start) === null).map((w) => w.text);

console.log(JSON.stringify({
  segments: tl.segments.length, editedSeconds: +tl.duration.toFixed(1),
  expectedWords: n, heardWords: m, wordErrorRate: +(d[n]![m]! / Math.max(1, n)).toFixed(3),
  fillersStillAudible: fillersLeft.map((w) => `${w.text}@${w.start.toFixed(1)}s`),
  keptWordsWithClippedOnset: clippedOnsets,
  differences: ops,
}, null, 2));
