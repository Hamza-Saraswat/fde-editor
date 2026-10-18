import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Clip } from "../src/core/schema.ts";

// paths.ts reads FDE_PROJECTS_DIR on first import: point it at a temp dir before anything loads
const ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "fde-conform-"));
  process.env.FDE_PROJECTS_DIR = join(root, "projects");
  return root;
});
const { ensureMaster, masterPath, masterSignature, needsMaster, videoSource } = await import("../src/media/conform.ts");
const { probeClip } = await import("../src/media/probe.ts");

const probe = (f: string, entry: string) =>
  execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", entry, "-of", "csv=p=0", f]).toString().trim();

describe("conformed masters", () => {
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
  const src = join(ROOT, "take.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3",
    "-c:v", "h264_videotoolbox", "-q:v", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);

  it("only clips with a picture fix need one, and the name changes with the fix", async () => {
    const clip: Clip = await probeClip(src, "c1");
    expect(needsMaster(clip)).toBe(false);
    expect(videoSource("p1", clip, "center")).toEqual({ path: src, crop: undefined });
    const mirrored = { ...clip, mirror: true };
    expect(needsMaster(mirrored)).toBe(true);
    expect(masterSignature(mirrored, "center")).not.toBe(masterSignature({ ...mirrored, stabilize: true }, "center"));
    expect(() => videoSource("p1", mirrored, "center")).toThrow(/master/);
  });

  it("a mirrored master keeps every frame and the audio, and becomes the video source", async () => {
    const clip: Clip = { ...(await probeClip(src, "c1")), mirror: true };
    const out = await ensureMaster("p1", clip, "center");
    expect(out).toBe(masterPath("p1", clip, "center"));
    expect(existsSync(out!)).toBe(true);
    expect(probe(out!, "stream=nb_read_frames")).toBe(probe(src, "stream=nb_read_frames"));
    expect(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out!]).toString().trim()).toBe("aac");
    expect(videoSource("p1", clip, "center")).toEqual({ path: out });
    // turning mirror off again: no master needed, the original is read
    expect(videoSource("p1", { ...clip, mirror: false }, "center").path).toBe(src);
  });
});
