import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipFromProbe, parseRate, probeClip, type ProbeJson } from "../src/media/probe.ts";
import { ConfigSchema } from "../src/core/schema.ts";

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
const probe = (file: string, entries: string, stream = "v:0") =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "default=nw=1", file]).toString();

const video = (over: Record<string, unknown> = {}) => ({
  codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p",
  r_frame_rate: "30/1", avg_frame_rate: "30/1", color_transfer: "bt709", color_primaries: "bt709", ...over,
});
const audio = { codec_type: "audio", codec_name: "aac" };
const json = (streams: object[], duration = "12.5"): ProbeJson => ({ streams, format: { duration } }) as ProbeJson;

describe("clipFromProbe", () => {
  it("reads a normal SDR camera file", () => {
    const c = clipFromProbe(json([video(), audio]), "/rec/take 1.mov", "c1");
    expect(c).toEqual({
      id: "c1", name: "take 1.mov", path: "/rec/take 1.mov", duration: 12.5, width: 1920, height: 1080,
      fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false,
    });
  });

  it("flags VFR when avg_frame_rate differs from r_frame_rate by more than 1%", () => {
    expect(clipFromProbe(json([video({ avg_frame_rate: "2750/100" })]), "/a.mp4", "c1").vfr).toBe(true);
    expect(clipFromProbe(json([video({ r_frame_rate: "30000/1001", avg_frame_rate: "29.9/1" })]), "/a.mp4", "c1").vfr).toBe(false);
    expect(clipFromProbe(json([video({ r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001" })]), "/a.mp4", "c1").fps).toBe(29.97);
  });

  it("treats a WebM-style 1000/1 base rate as VFR and uses the average fps", () => {
    const c = clipFromProbe(json([video({ codec_name: "vp9", r_frame_rate: "1000/1", avg_frame_rate: "30/1" })]), "/s.webm", "c2");
    expect(c.vfr).toBe(true);
    expect(c.fps).toBe(30);
  });

  it("flags HDR for HLG, PQ, and 10-bit BT.2020", () => {
    expect(clipFromProbe(json([video({ color_transfer: "arib-std-b67", pix_fmt: "yuv420p10le" })]), "/h.mov", "c1").hdr).toBe(true);
    expect(clipFromProbe(json([video({ color_transfer: "smpte2084", pix_fmt: "yuv420p10le" })]), "/h.mov", "c1").hdr).toBe(true);
    expect(clipFromProbe(json([video({ color_transfer: undefined, color_primaries: "bt2020", pix_fmt: "yuv420p10le" })]), "/h.mov", "c1").hdr).toBe(true);
    expect(clipFromProbe(json([video({ pix_fmt: "yuv422p10le" })]), "/prores.mov", "c1").hdr).toBe(false);
  });

  it("ignores cover-art streams, notices missing audio and swaps size for rotated video", () => {
    const art = { codec_type: "video", codec_name: "mjpeg", width: 300, height: 300, disposition: { attached_pic: 1 } };
    const c = clipFromProbe(json([art, video({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })]), "/p.mov", "c1");
    expect(c.hasAudio).toBe(false);
    expect(c.codec).toBe("h264");
    expect([c.width, c.height]).toEqual([1080, 1920]);
  });

  it("throws without a video stream or duration", () => {
    expect(() => clipFromProbe(json([audio]), "/a.m4a", "c1")).toThrow(/no video stream/);
    expect(() => clipFromProbe({ streams: [video()] } as ProbeJson, "/a.mp4", "c1")).toThrow(/duration/);
  });

  it("parseRate", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRate("0/0")).toBe(0);
    expect(parseRate(undefined)).toBe(0);
    expect(parseRate("25")).toBe(25);
  });
});

describe("prepareClip (synthetic 3 s clip)", () => {
  let root: string;
  let prep: typeof import("../src/media/prepare.ts");
  let paths: typeof import("../src/core/paths.ts");
  const config = ConfigSchema.parse({ output: { width: 320, height: 180, fps: 30 } });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fde-media-"));
    process.env.FDE_PROJECTS_DIR = join(root, "projects");
    prep = await import("../src/media/prepare.ts");
    paths = await import("../src/core/paths.ts");
    expect(paths.projectPaths("p1").root.startsWith(root)).toBe(true); // never write into the repo's projects/
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("makes proxy, 48k wav, 16k wav and mp3, then skips them when fresh", async () => {
    const src = join(root, "take.mp4");
    // 44.1 kHz mono source audio, so every output has to convert
    ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=3",
      "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-shortest", src]);
    const clip = await probeClip(src, "c1");
    expect(clip).toMatchObject({ width: 320, height: 180, fps: 30, hasAudio: true, vfr: false, hdr: false });

    const seen: number[] = [];
    const t0 = Date.now();
    const out = await prep.prepareClip("p1", clip, { config, onProgress: (f) => seen.push(f) });
    console.log(`prepareClip 3 s clip: ${Date.now() - t0} ms`);
    expect(out.made.sort()).toEqual(["asrMp3", "asrWav", "proxy", "wav"]);
    const p = paths.projectPaths("p1");
    expect(out.proxy).toBe(p.proxy("c1"));

    expect(probe(p.proxy("c1"), "stream=codec_name,pix_fmt,r_frame_rate,height")).toMatch(/codec_name=h264[\s\S]*height=180[\s\S]*pix_fmt=yuv420p[\s\S]*r_frame_rate=30\/1/);
    expect(probe(p.proxy("c1"), "stream=codec_name", "a:0")).toContain("aac");
    expect(probe(p.wav("c1"), "stream=sample_rate,channels,codec_name", "a:0")).toMatch(/codec_name=pcm_s16le[\s\S]*sample_rate=48000[\s\S]*channels=2/);
    expect(probe(p.asrWav("c1"), "stream=sample_rate,channels", "a:0")).toMatch(/sample_rate=16000[\s\S]*channels=1/);
    expect(probe(p.asrMp3("c1"), "stream=codec_name,channels", "a:0")).toMatch(/codec_name=mp3[\s\S]*channels=1/);
    const wavSeconds = Number(probe(p.wav("c1"), "stream=duration", "a:0").split("=")[1]);
    expect(Math.abs(wavSeconds - 3)).toBeLessThan(0.03);
    expect(seen.at(-1)).toBe(1);

    const mtime = statSync(p.wav("c1")).mtimeMs;
    const again = await prep.prepareClip("p1", clip, { config });
    expect(again.made).toEqual([]);
    expect(statSync(p.wav("c1")).mtimeMs).toBe(mtime);
  });

  it("conforms a VFR recording to CFR in the proxy", async () => {
    const src = join(root, "vfr.mp4");
    // drop every 5th frame without retiming: 30 fps base rate, 24 fps average
    ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-vf", "select='not(eq(mod(n\\,5)\\,0))'", "-fps_mode", "vfr",
      "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", src]);
    const clip = await probeClip(src, "c2");
    expect(clip.vfr).toBe(true);
    expect(clip.hasAudio).toBe(false);
    await prep.prepareClip("p1", clip, { config });
    const p = paths.projectPaths("p1");
    const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
      "stream=nb_read_frames", "-of", "csv=p=0", p.proxy("c2")]).toString().trim());
    expect(Math.abs(frames - 90)).toBeLessThanOrEqual(1);
    expect(probe(p.proxy("c2"), "stream=avg_frame_rate")).toContain("30/1");
    // no audio in the source -> silent render wav of the clip's length
    expect(probe(p.wav("c2"), "stream=sample_rate", "a:0")).toContain("48000");
  });

  it("refuses HDR clips with a clear message", async () => {
    const clip = { ...(await probeClip(join(root, "take.mp4"), "c3")), name: "hdr.mov", hdr: true };
    await expect(prep.prepareClip("p1", clip, { config })).rejects.toThrow(/hdr\.mov is HDR \(HLG\/PQ\)\. Record in SDR/);
  });
});
