import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type Clip, type Timeline } from "../src/core/schema.ts";
import { probeClip } from "../src/media/probe.ts";
import { loudnormFilter, parseLoudnormJson } from "../src/media/loudness.ts";
import {
  audioPieceArgs, profileSignature, resolveProfile, sampleRange, segmentKey, videoSegmentArgs,
} from "../src/media/segments.ts";
import {
  concatList, finalBitrateMbps, overlayFiltergraph, sideAudioChain, sideVideoChain,
} from "../src/media/render.ts";

// paths.ts reads FDE_PROJECTS_DIR when it is first imported, and the static imports above load
// it, so the temp projects dir must be set before any import runs.
const ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fde-render-"));
  process.env.FDE_PROJECTS_DIR = join(dir, "projects");
  return dir;
});

const FPS = 30;
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
const probeVal = (file: string, entries: string, stream: string, extra: string[] = []) =>
  execFileSync("ffprobe", ["-v", "error", ...extra, "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();
const countFrames = (file: string) => Number(probeVal(file, "stream=nb_read_frames", "v:0", ["-count_frames"]));
const formatDuration = (file: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
/** Average RGB of the frame at time t (scaled to 1×1). */
const avgRgb = (file: string, t: number) => [...ff(["-ss", t.toFixed(4), "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];

/** Frame-snapped timeline over one clip from [start, end) second ranges. */
function makeTimeline(ranges: [number, number][], clipId = "c1"): Timeline {
  let out = 0;
  const segments = ranges.map(([s, e]) => {
    const f0 = Math.round(s * FPS);
    const f1 = Math.round(e * FPS);
    const seg = { clipId, start: f0 / FPS, end: f1 / FPS, frames: f1 - f0, outStart: out / FPS };
    out += f1 - f0;
    return seg;
  });
  return { fps: FPS, segments, duration: out / FPS, overlays: [], chapters: [] };
}

describe("render arg builders", () => {
  const clip = { path: "/rec/a.mov" };
  const seg = { start: 2, frames: 45 };
  const stat = { mtimeMs: 1000, size: 5000 };

  it("segment keys change with every input that changes pixels", () => {
    const k = segmentKey(clip, seg, "preview", FPS, stat);
    expect(k).toMatch(/^[0-9a-f]{40}$/);
    expect(segmentKey(clip, seg, "preview", FPS, stat)).toBe(k);
    expect(segmentKey(clip, { start: 2 + 1 / FPS, frames: 45 }, "preview", FPS, stat)).not.toBe(k);
    expect(segmentKey(clip, { start: 2, frames: 46 }, "preview", FPS, stat)).not.toBe(k);
    expect(segmentKey(clip, seg, "final", FPS, stat)).not.toBe(k);
    expect(segmentKey(clip, seg, "preview", FPS, { ...stat, mtimeMs: 2000 })).not.toBe(k);
    expect(segmentKey({ path: "/rec/b.mov" }, seg, "preview", FPS, stat)).not.toBe(k);
    // tiny float noise in start on the frame grid doesn't matter
    expect(segmentKey(clip, { start: 2.0000001, frames: 45 }, "preview", FPS, stat)).toBe(k);
  });

  it("profiles: preview ≤ 720 high at the output aspect, final at output size", () => {
    expect(resolveProfile("preview", { width: 2560, height: 1440 }, 30)).toMatchObject({ width: 1280, height: 720 });
    expect(resolveProfile("final", { width: 2560, height: 1440 }, 30)).toMatchObject({ width: 2560, height: 1440 });
    expect(resolveProfile("preview", { width: 320, height: 180 }, 30)).toMatchObject({ width: 320, height: 180 });
    const fin = resolveProfile("final", { width: 2560, height: 1440 }, 30);
    expect(fin.codecArgs).toEqual(["-c:v", "hevc_videotoolbox", "-q:v", "75", "-tag:v", "hvc1", "-g", "30"]);
    expect(profileSignature(fin)).toContain("final:2560x1440@30");
  });

  it("video segment args follow the spike recipe", () => {
    const args = videoSegmentArgs("/rec/a.mov", seg, resolveProfile("final", { width: 2560, height: 1440 }, 30), "/o.mp4");
    expect(args.slice(0, 4)).toEqual(["-ss", "2.000000", "-i", "/rec/a.mov"]);
    expect(args).toEqual(expect.arrayContaining(["-an", "-frames:v", "45", "-r", "30", "-fps_mode", "cfr", "-video_track_timescale", "15360"]));
    const vf = args[args.indexOf("-vf") + 1]!;
    expect(vf).toContain("scale=2560:1440:force_original_aspect_ratio=decrease");
    expect(vf).toContain("pad=2560:1440:(ow-iw)/2:(oh-ih)/2");
    expect(vf).toContain("format=yuv420p");
  });

  it("audio pieces are sample exact", () => {
    expect(sampleRange({ start: 2, frames: 45 }, 30)).toEqual([96000, 168000]);
    const layout = { dataOffset: 78, channels: 2, sampleRate: 48000, bits: 16, format: 1 };
    const fast = audioPieceArgs("/a.wav", layout, [96000, 168000], 30, "/o.wav");
    expect(fast).toEqual(expect.arrayContaining(["-skip_initial_bytes", String(78 + 96000 * 4)]));
    expect(fast[fast.indexOf("-af") + 1]).toBe(
      "atrim=end_sample=72000,asetpts=PTS-STARTPTS,apad=whole_len=72000,afade=t=in:d=0.030000,afade=t=out:st=1.470000:d=0.030000");
    const slow = audioPieceArgs("/a.wav", null, [96000, 168000], 30, "/o.wav");
    expect(slow[slow.indexOf("-af") + 1]).toMatch(/^atrim=start_sample=96000:end_sample=168000,/);
    expect(audioPieceArgs(null, null, [0, 4800], 30, "/o.wav")).toEqual(expect.arrayContaining(["anullsrc=r=48000:cl=stereo", "atrim=end_sample=4800"]));
  });

  it("concat list escapes quotes", () => {
    expect(concatList(["/a/b.mp4", "/it's/c.mp4"])).toBe("file '/a/b.mp4'\nfile '/it'\\''s/c.mp4'\n");
  });

  it("overlay filtergraph", () => {
    const g = overlayFiltergraph(
      [{ start: 2.5, end: 7, width: 2560, height: 1440 }, { start: 10, end: 12.25, width: 1920, height: 1080 }],
      { mainIn: "[0:v]", firstInput: 1, width: 2560, height: 1440, out: "[main]" },
    );
    expect(g).toBe([
      "[1:v]setpts=PTS-STARTPTS+2.5/TB[ov0]",
      "[0:v][ov0]overlay=0:0:eof_action=pass:format=auto:enable='between(t,2.5,7)'[m0]",
      "[2:v]scale=2560:1440,setpts=PTS-STARTPTS+10/TB[ov1]",
      "[m0][ov1]overlay=0:0:eof_action=pass:format=auto:enable='between(t,10,12.25)'[main]",
    ].join(";"));
    expect(overlayFiltergraph([], { mainIn: "[0:v]", firstInput: 1, width: 1, height: 1, out: "[main]" })).toBe("[0:v]null[main]");
  });

  it("intro/outro chains conform size, fps, length and audio", () => {
    expect(sideVideoChain(3, { frames: 30, alpha: false }, 320, 180, 30, "[vi]")).toBe(
      "[3:v]scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1," +
      "fps=30,format=yuv420p,tpad=stop=-1:stop_mode=clone,trim=end_frame=30,setpts=PTS-STARTPTS[vi]");
    expect(sideVideoChain(3, { frames: 30, alpha: true }, 320, 180, 30, "[vi]")).toMatch(/^color=c=black:s=320x180:r=30\[bg3\];.*overlay=0:0:shortest=1/);
    expect(sideAudioChain(null, 48000, "[ai]")).toBe("anullsrc=r=48000:cl=stereo,atrim=end_sample=48000[ai]");
    expect(sideAudioChain(2, 48000, "[ai]")).toMatch(/^\[2:a:0\]aresample=48000.*apad=whole_len=48000,atrim=end_sample=48000\[ai\]$/);
  });

  it("loudnorm filter strings (BLAI assemble.py port)", () => {
    const t = { I: -14, TP: -1.5, LRA: 11 };
    expect(loudnormFilter(t)).toBe("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
    const m = { input_i: -23.12, input_tp: -6.3, input_lra: 4.1, input_thresh: -33.4, target_offset: 0.21 };
    expect(loudnormFilter(t, m)).toBe(
      "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-23.12:measured_TP=-6.3:measured_LRA=4.1:measured_thresh=-33.4:offset=0.21:linear=true");
    expect(loudnormFilter(t, { ...m, input_i: -Infinity })).toBe("loudnorm=I=-14:TP=-1.5:LRA=11");
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.12",\n\t"input_tp" : "-6.30",\n\t"input_lra" : "4.10",\n\t"input_thresh" : "-33.40",\n` +
      `\t"output_i" : "-14.0",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.21"\n}\n`;
    expect(parseLoudnormJson(stderr)).toEqual({ input_i: -23.12, input_tp: -6.3, input_lra: 4.1, input_thresh: -33.4, target_offset: 0.21 });
    expect(() => parseLoudnormJson("nothing")).toThrow();
  });

  it("final bitrate scales from 45 Mb/s at 1440p30", () => {
    expect(finalBitrateMbps(2560, 1440, 30)).toBe(45);
    expect(finalBitrateMbps(1920, 1080, 30)).toBe(25);
    expect(finalBitrateMbps(320, 180, 30)).toBe(4);
  });
});

describe("segment cache, preview and final (synthetic media)", () => {
  let root: string;
  let src: string;
  let clip: Clip;
  let segments: typeof import("../src/media/segments.ts");
  let render: typeof import("../src/media/render.ts");
  let loudness: typeof import("../src/media/loudness.ts");
  let paths: ReturnType<typeof import("../src/core/paths.ts").projectPaths>;
  const config = ConfigSchema.parse({ output: { width: 320, height: 180, fps: FPS } });
  // 10 s clip, 5 kept segments (~6.2 s)
  const timeline = makeTimeline([[0.5, 1.5], [2, 3.2], [4, 5], [6.1, 7.5], [8, 9.6]]);
  const totalFrames = timeline.segments.reduce((n, s) => n + s.frames, 0);

  beforeAll(async () => {
    root = ROOT;
    segments = await import("../src/media/segments.ts");
    render = await import("../src/media/render.ts");
    loudness = await import("../src/media/loudness.ts");
    paths = (await import("../src/core/paths.ts")).projectPaths("r1");
    expect(paths.root.startsWith(ROOT)).toBe(true); // never write into the repo's projects/
    src = join(root, "take.mp4");
    ff(["-f", "lavfi", "-i", `testsrc2=s=320x180:r=${FPS}:d=10`, "-f", "lavfi", "-i", "sine=f=1000:r=48000:d=10",
      "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", src]);
    clip = await probeClip(src, "c1");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("buildPreview: frame-exact concat with matching audio, cached on rebuild", async () => {
    const steps: number[] = [];
    const res = await render.buildPreview("r1", timeline, { clips: [clip], config, onProgress: (f) => steps.push(f) });
    console.log(`buildPreview cold (5 segments): ${res.ms} ms`);
    expect(res.encoded).toBe(5);
    expect(steps.at(-1)).toBe(1);
    expect(countFrames(paths.preview)).toBe(totalFrames);
    const vDur = Number(probeVal(paths.preview, "stream=duration", "v:0"));
    const aDur = Number(probeVal(paths.preview, "stream=duration", "a:0"));
    expect(Math.abs(vDur - totalFrames / FPS)).toBeLessThan(0.001);
    expect(Math.abs(aDur - vDur)).toBeLessThan(0.001);
    // the cached PCM pieces add up to exactly the video length, sample for sample
    const audioDir = segments.segmentDirs("r1", "preview").audio;
    const samples = readdirSync(audioDir).filter((f) => f.endsWith(".wav"))
      .reduce((n, f) => n + Number(probeVal(join(audioDir, f), "stream=duration_ts", "a:0")), 0);
    expect(samples).toBe((totalFrames / FPS) * 48000);

    const warm = await render.buildPreview("r1", timeline, { clips: [clip], config });
    console.log(`buildPreview warm (all cached): ${warm.ms} ms`);
    expect(warm.encoded).toBe(0);
    expect(warm.reused).toBe(5);

    // toggling one cut changes one segment -> one new encode
    const toggled = makeTimeline([[0.5, 1.5], [2, 3.2], [4, 5.5], [6.1, 7.5], [8, 9.6]]);
    const t = await render.buildPreview("r1", toggled, { clips: [clip], config });
    console.log(`buildPreview after one toggle: ${t.ms} ms`);
    expect(t.encoded).toBe(1);
    expect(countFrames(paths.preview)).toBe(totalFrames + 15);
  });

  it("cancels cleanly: rejects and leaves no .part files behind", async () => {
    const ac = new AbortController();
    const fresh = makeTimeline([[0.2, 0.9], [1.1, 1.8], [2.3, 2.9], [3.1, 3.7], [5.2, 5.9], [6.0, 6.05]]);
    const run = render.buildPreview("r1", fresh, { clips: [clip], config, signal: ac.signal, onProgress: (f) => f > 0 && ac.abort() });
    await expect(run).rejects.toThrow();
    const dirs = segments.segmentDirs("r1", "preview");
    for (const d of [dirs.video, dirs.audio]) expect(readdirSync(d).filter((f) => f.includes(".part"))).toEqual([]);
    // the next run picks up where the cancelled one stopped
    const resumed = await render.buildPreview("r1", fresh, { clips: [clip], config });
    expect(resumed.encoded).toBeLessThan(fresh.segments.length);
    expect(countFrames(paths.preview)).toBe(fresh.segments.reduce((n, s) => n + s.frames, 0));
  });

  it("frame accuracy: a segment's first frame matches the source frame at its in-point", async () => {
    const seg = timeline.segments[3]!;
    const f = (await segments.ensureSegments("r1", timeline, "preview", { clips: [clip], config })).files[3]!;
    const psnr = (offset: number) => {
      const a = join(root, "seg0.png");
      const b = join(root, `src${offset}.png`);
      ff(["-i", f.video, "-frames:v", "1", a]);
      ff(["-ss", ((Math.round(seg.start * FPS) + offset) / FPS).toFixed(6), "-i", src, "-frames:v", "1", b]);
      const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" });
      const m = /average:([\d.]+|inf)/.exec(r.stderr);
      return m ? (m[1] === "inf" ? 999 : Number(m[1])) : 0;
    };
    const [prev, at, next] = [psnr(-1), psnr(0), psnr(1)];
    expect(at).toBeGreaterThan(prev);
    expect(at).toBeGreaterThan(next);
  });

  it("renderFinal: graphics, intro/outro, exact duration, loudness on target", async () => {
    const overlay = join(root, "g1.mov");
    ff(["-f", "lavfi", "-i", "color=c=red@0.5:s=320x180:r=30:d=2,format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4444", overlay]);
    // intro: different size and fps, no audio; outro: audio, 0.5 s
    const intro = join(root, "intro.mp4");
    ff(["-f", "lavfi", "-i", "testsrc=s=640x360:r=25:d=1", "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", intro]);
    const outro = join(root, "outro.mov");
    ff(["-f", "lavfi", "-i", "smptebars=s=320x180:r=30:d=0.5", "-f", "lavfi", "-i", "sine=f=300:r=44100:d=0.5",
      "-c:v", "prores_ks", "-c:a", "pcm_s16le", "-shortest", outro]);

    const ovStart = 1.0;
    const ovEnd = 2.5;
    const steps: string[] = [];
    const res = await render.renderFinal("r1", timeline, {
      clips: [clip], config, intro, outro,
      overlays: [{ cueId: "g1", file: overlay, start: ovStart, end: ovEnd }],
      onProgress: (f, m) => steps.push(`${f.toFixed(2)} ${m}`),
    });
    console.log(`renderFinal (5 segments, 1 graphic, intro+outro): ${res.ms} ms`);
    expect(res.introSeconds).toBe(1);
    expect(res.outroSeconds).toBe(0.5);
    expect(res.arollSeconds).toBeCloseTo(totalFrames / FPS, 9);

    const expectFrames = 30 + totalFrames + 15;
    expect(res.frames).toBe(expectFrames);
    expect(countFrames(paths.final)).toBe(expectFrames);
    expect(Math.abs(formatDuration(paths.final) - expectFrames / FPS)).toBeLessThanOrEqual(1 / FPS);
    const aDur = Number(probeVal(paths.final, "stream=duration", "a:0"));
    expect(Math.abs(aDur - expectFrames / FPS)).toBeLessThanOrEqual(1 / FPS);
    expect(probeVal(paths.final, "stream=codec_name,width,height,pix_fmt,color_transfer,color_primaries", "v:0")).toBe("h264,320,180,yuv420p,bt709,bt709");

    // inside the graphic window the frame turns red vs the plain A-roll; outside it matches
    const aroll = join(paths.cacheDir, "aroll.mp4");
    const tIn = 1.75 + 0.5 / FPS;
    const tOut = 4.0 + 0.5 / FPS;
    const diff = (t: number) => {
      const a = avgRgb(aroll, t);
      const f = avgRgb(paths.final, t + res.introSeconds);
      return [f[0]! - a[0]!, f[1]! - a[1]!, f[2]! - a[2]!];
    };
    const red = (t: number) => { const [r, g] = diff(t); return r! - g!; };
    expect(red(tIn)).toBeGreaterThan(60);
    for (const d of diff(tOut)) expect(Math.abs(d)).toBeLessThan(12);
    // the graphic lands on its start frame and leaves after its end
    // input -ss returns the first frame with pts >= t, so aim a quarter frame early
    const frameT = (f: number) => Math.max(0, (f - 0.25) / FPS);
    expect(red(frameT(ovStart * FPS - 1))).toBeLessThan(15);
    expect(red(frameT(ovStart * FPS))).toBeGreaterThan(60);
    expect(red(frameT(ovEnd * FPS - 1))).toBeGreaterThan(60);
    expect(red(frameT(ovEnd * FPS + 1))).toBeLessThan(15);
    // intro is first: frame 0.5 s comes from testsrc (intro), not the A-roll
    expect(avgRgb(paths.final, 0.5)).not.toEqual(avgRgb(aroll, 0.5));

    const m = await loudness.measureLoudness(paths.final, config.loudness);
    console.log(`final loudness: ${m.input_i} LUFS, TP ${m.input_tp}`);
    expect(Math.abs(m.input_i - config.loudness.I)).toBeLessThanOrEqual(1);
    expect(m.input_tp).toBeLessThanOrEqual(config.loudness.TP + 0.5);

    // X clip: 2 s with the overlay as a caption layer
    const xOut = join(paths.outDir, "x-clips", "x1.mp4");
    const x = await render.renderXClip("r1", paths.final, { start: 2, end: 4 }, overlay, xOut, {});
    expect(x.frames).toBe(60);
    expect(countFrames(xOut)).toBe(60);
    expect(probeVal(xOut, "stream=codec_name,width,height", "v:0")).toBe("h264,320,180");
    expect(probeVal(xOut, "stream=codec_name", "a:0")).toBe("aac");
  });
});
