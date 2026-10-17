import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareOutputArgs } from "../src/media/prepare.ts";
import { letterboxFrom, parseCropdetect, probeClip } from "../src/media/probe.ts";
import { resolveProfile, videoSegmentArgs } from "../src/media/segments.ts";

// CapCut's teleprompter saved the v2 test take as a 1080×1920 canvas with the 16:9 shot in a band
// (cropdetect: crop=1080:608:0:656). Import should find that band and every encode should use it.
const band = { w: 1080, h: 608, x: 0, y: 656 };
const portrait = { width: 1080, height: 1920 };

describe("letterbox detection", () => {
  it("reads cropdetect's last report", () => {
    expect(parseCropdetect("[Parsed_cropdetect_0] x1:0 crop=1080:1920:0:0\n[Parsed_cropdetect_0] crop=1080:608:0:656\n")).toEqual(band);
    expect(parseCropdetect("no crop lines")).toBeNull();
  });

  it("accepts a 16:9 band that every sample agrees on", () => {
    expect(letterboxFrom([band, { ...band, y: 658 }, band], portrait)).toEqual(band);
  });

  it("rejects disagreement, a full frame, or a box that isn't 16:9", () => {
    expect(letterboxFrom([band, { w: 1080, h: 1200, x: 0, y: 360 }, band], portrait)).toBeNull(); // a dark moment
    expect(letterboxFrom([{ w: 2560, h: 1440, x: 0, y: 0 }], { width: 2560, height: 1440 })).toBeNull();
    expect(letterboxFrom([{ w: 1080, h: 1080, x: 0, y: 420 }], portrait)).toBeNull(); // square: not our case
    expect(letterboxFrom([null, band], portrait)).toBeNull();
  });

  it("crops first in the proxy and the render segments", () => {
    const clip = { id: "c1", name: "t", path: "/t.mov", duration: 10, width: 1080, height: 608, fps: 30, codec: "hevc", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false, crop: band };
    const proxy = prepareOutputArgs("proxy", clip, 30, "0:a:0", "/p.mp4");
    expect(proxy[proxy.indexOf("-vf") + 1]).toMatch(/^crop=1080:608:0:656,scale=/);
    const seg = videoSegmentArgs("/t.mov", { start: 1, frames: 30 }, resolveProfile("final", { width: 2560, height: 1440 }, 30), "/o.mp4", { crop: band });
    expect(seg[seg.indexOf("-vf") + 1]).toMatch(/^crop=1080:608:0:656,scale=2560:1440/);
  });
});

describe("probeClip on a letterboxed recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "fde-letterbox-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the band and reports the picture's size", async () => {
    const file = join(dir, "capcut.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x304:r=30:d=8",
      "-vf", "pad=540:960:0:328:black", "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", file]);
    const clip = await probeClip(file, "c1");
    expect(clip.crop).toEqual({ w: 540, h: 304, x: 0, y: 328 });
    expect([clip.width, clip.height]).toEqual([540, 304]);
  });

  it("leaves a normal recording alone", async () => {
    const file = join(dir, "normal.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=8", "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", file]);
    const clip = await probeClip(file, "c1");
    expect(clip.crop).toBeUndefined();
  });
});
