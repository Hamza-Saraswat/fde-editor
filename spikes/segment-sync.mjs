// Phase 0 spike (d): cut N frame-snapped segments from a real take, concat them,
// and check (1) exact frame counts, (2) A/V duration match, (3) first frame of a
// segment matches the source frame at its in-point (frame accuracy).
// Usage: node spikes/segment-sync.mjs "<source video>" [count] [height]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2];
const COUNT = Number(process.argv[3] ?? 200);
const HEIGHT = Number(process.argv[4] ?? 720);
const FPS = 30;
const SR = 48000;
const OUT = join(import.meta.dirname, "out", `segments-${HEIGHT}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
const probe = (file, entries, stream = "v:0") =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-count_frames", "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

// Deterministic pseudo-random keep segments, snapped to the frame grid.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const segs = [];
let tFrames = 60 * FPS; // start at 60 s
for (let i = 0; i < COUNT; i++) {
  tFrames += Math.round((0.1 + rand() * 0.5) * FPS); // a cut of 0.1–0.6 s
  const len = Math.round((0.6 + rand() * 1.0) * FPS); // keep 0.6–1.6 s
  segs.push({ inF: tFrames, frames: len });
  tFrames += len;
}

// Full audio once as 48 kHz PCM; pieces are cut by exact sample index.
const wav = join(OUT, "source.wav");
ff(["-i", SRC, "-vn", "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", wav]);

const t0 = Date.now();
const vList = [], aList = [];
segs.forEach((s, i) => {
  const inSec = (s.inF / FPS).toFixed(6);
  const v = join(OUT, `v${String(i).padStart(4, "0")}.mp4`);
  ff([
    "-ss", inSec, "-i", SRC, "-an", "-frames:v", String(s.frames),
    "-vf", `scale=-2:${HEIGHT},format=yuv420p`, "-r", String(FPS), "-fps_mode", "cfr",
    "-c:v", "h264_videotoolbox", "-q:v", "65", "-g", String(FPS), "-video_track_timescale", "15360", v,
  ]);
  const a = join(OUT, `a${String(i).padStart(4, "0")}.wav`);
  const startSample = (s.inF / FPS) * SR, endSample = ((s.inF + s.frames) / FPS) * SR;
  ff(["-i", wav, "-af", `atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS,afade=t=in:d=0.03,afade=t=out:st=${(s.frames / FPS - 0.03).toFixed(4)}:d=0.03`, "-c:a", "pcm_s16le", a]);
  vList.push(`file '${v}'`);
  aList.push(`file '${a}'`);
});
const encodeSec = (Date.now() - t0) / 1000;

writeFileSync(join(OUT, "v.txt"), vList.join("\n"));
writeFileSync(join(OUT, "a.txt"), aList.join("\n"));
const vOut = join(OUT, "video.mp4"), aOut = join(OUT, "audio.wav"), muxed = join(OUT, "muxed.mp4");
ff(["-f", "concat", "-safe", "0", "-i", join(OUT, "v.txt"), "-c", "copy", vOut]);
ff(["-f", "concat", "-safe", "0", "-i", join(OUT, "a.txt"), "-c", "copy", aOut]);
ff(["-i", vOut, "-i", aOut, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", muxed]);

const expectedFrames = segs.reduce((n, s) => n + s.frames, 0);
const gotFrames = Number(probe(vOut, "stream=nb_read_frames"));
const audioSamples = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", aOut]).toString().trim());
const vDur = gotFrames / FPS, aDur = audioSamples / SR;

// Frame accuracy: compare segment first frame vs source frames at in-1, in, in+1 (PSNR, higher = closer).
const accuracy = [0, 50, 100, 150, Math.min(199, COUNT - 1)].filter((i) => i < COUNT).map((i) => {
  const s = segs[i];
  const seg0 = join(OUT, `chk${i}-seg.png`);
  ff(["-i", join(OUT, `v${String(i).padStart(4, "0")}.mp4`), "-frames:v", "1", seg0]);
  const scores = [-1, 0, 1].map((d) => {
    const src = join(OUT, `chk${i}-src${d}.png`);
    ff(["-ss", ((s.inF + d) / FPS).toFixed(6), "-i", SRC, "-frames:v", "1", "-vf", `scale=-2:${HEIGHT},format=yuv420p`, src]);
    const r = spawnSync("ffmpeg", ["-i", seg0, "-i", src, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" });
    const m = /average:([\d.inf]+)/.exec(r.stderr);
    return { offset: d, psnr: m ? m[1] : "?" };
  });
  const best = scores.reduce((a, b) => (Number(b.psnr) > Number(a.psnr) || b.psnr === "inf" ? b : a));
  return { i, best: best.offset, scores };
});

const result = {
  segments: COUNT, height: HEIGHT, encodeSeconds: encodeSec,
  expectedFrames, gotFrames, framesMatch: expectedFrames === gotFrames,
  videoSeconds: vDur, audioSeconds: aDur, avDriftMs: Math.round((aDur - vDur) * 1000 * 100) / 100,
  frameAccuracy: accuracy.map((a) => ({ segment: a.i, bestOffsetFrames: a.best, psnr: a.scores.map((s) => `${s.offset}:${s.psnr}`).join(" ") })),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
