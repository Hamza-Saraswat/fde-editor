#!/usr/bin/env python3
"""Tripod-style stabilization for talking-head recordings.

The camera is meant to be still; the shake comes from the speaker hitting the
table (sudden jolts that decay). We track background motion, smooth the camera
path with a wide Gaussian (jolts go, slow drift stays) and warp every frame
back onto the smooth path with a fixed zoom that hides the borders.

Frame count, frame rate and duration are preserved exactly, because cuts and
audio downstream are built on the original timing.

  analyze INPUT OUT.json [--crop W:H:X:Y] [--mirror] [--mask left|center|right|none]
                         [--smooth SECONDS] [--max-zoom 1.06] [--limit-seconds S]
  apply   INPUT ANALYSIS.json OUT.mp4 [--codec hevc|h264]

Needs python3 with cv2 + numpy, and ffmpeg/ffprobe on PATH.
"""
import argparse
import json
import math
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from fractions import Fraction

import cv2
import numpy as np

VERSION = 1
TRACK_WIDTH = 640
MASKS = ("left", "center", "right", "none")
# Hardware decode on macOS: same frames (luma bit-identical, chroma within a level or two)
# for a fraction of the CPU; ffmpeg falls back to software when it cannot.
HWACCEL = ["-hwaccel", "videotoolbox"] if sys.platform == "darwin" else []
CODECS = {
    "hevc": ["-c:v", "hevc_videotoolbox", "-q:v", "80", "-tag:v", "hvc1"],
    "h264": ["-c:v", "h264_videotoolbox", "-q:v", "80"],
}


class StabilizeError(Exception):
    pass


# ---------------------------------------------------------------------------
# Pure maths (no video needed; covered by stabilize_selftest.py)
# ---------------------------------------------------------------------------

def gaussian_smooth(x, sigma):
    """Gaussian-smooth each column of x (N x K) with reflect edge handling."""
    x = np.asarray(x, dtype=np.float64)
    if sigma <= 0 or len(x) < 2:
        return x.copy()
    radius = int(math.ceil(3 * sigma))
    t = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (t / sigma) ** 2)
    kernel /= kernel.sum()
    out = np.empty_like(x)
    for k in range(x.shape[1]):
        padded = np.pad(x[:, k], radius, mode="reflect")
        out[:, k] = np.convolve(padded, kernel, mode="valid")
    return out


def compute_corrections(transforms, fps, smooth_seconds):
    """transforms: per-frame motion (dx, dy, da) from the previous frame; row 0 is zero.

    Returns (trajectory, smoothed, corrections). Applying corrections[i] to frame i
    moves it from its real position onto the smoothed camera path.
    """
    trajectory = np.cumsum(np.asarray(transforms, dtype=np.float64), axis=0)
    smoothed = gaussian_smooth(trajectory, smooth_seconds * fps)
    return trajectory, smoothed, smoothed - trajectory


def required_zoom(corrections, width, height):
    """Per-frame zoom needed so the warped frame shows no border.

    The warp is dst - c = z * (R(a) (src - c) + t) about the centre c. Every output
    corner q must map back inside the source: |R(-a) (q/z - t)| <= half-size on
    both axes. Each of the 8 constraints is linear in u = 1/z, so solve for the
    largest u directly.
    """
    corr = np.atleast_2d(np.asarray(corrections, dtype=np.float64))
    cx, cy, ca = corr[:, 0], corr[:, 1], corr[:, 2]
    cos, sin = np.cos(ca), np.sin(ca)
    hw, hh = (width - 1) / 2.0, (height - 1) / 2.0
    u = np.ones(len(corr))
    for qx, qy in ((hw, hh), (hw, -hh), (-hw, hh), (-hw, -hh)):
        # R(-a) = [[cos, sin], [-sin, cos]]; component = a*u - b
        for a, b, lim in ((cos * qx + sin * qy, cos * cx + sin * cy, hw),
                          (-sin * qx + cos * qy, -sin * cx + cos * cy, hh)):
            bound = (lim + np.sign(a) * b) / np.maximum(np.abs(a), 1e-9)
            u = np.minimum(u, bound)
    with np.errstate(divide="ignore"):
        return np.where(u > 0, 1.0 / np.maximum(u, 1e-12), np.inf)


def fit_zoom(corrections, width, height, max_zoom):
    """One zoom for the whole clip (a varying zoom would visibly breathe).

    Returns (zoom, corrections, clamped_frames). If a frame needs more than
    max_zoom, its correction is scaled down until it fits, so borders never show.
    """
    corr = np.asarray(corrections, dtype=np.float64).copy()
    if len(corr) == 0:
        return 1.0, corr, 0
    need = required_zoom(corr, width, height)
    over = need > max_zoom
    if over.any():
        # Binary-search the largest scale k in [0, 1] per frame that fits at max_zoom.
        lo, hi = np.zeros(over.sum()), np.ones(over.sum())
        for _ in range(30):
            mid = (lo + hi) / 2
            fits = required_zoom(corr[over] * mid[:, None], width, height) <= max_zoom
            lo, hi = np.where(fits, mid, lo), np.where(fits, hi, mid)
        corr[over] *= lo[:, None]
        need = required_zoom(corr, width, height)
    zoom = float(min(max(need.max(), 1.0), max_zoom))
    return zoom, corr, int(over.sum())


def shake_profile(trajectory, smoothed, fps, width):
    """Shake per second: RMS of the jitter (trajectory - smoothed, translation only)
    in percent of frame width. Returns (per_second, peak, mean)."""
    jitter = np.asarray(trajectory, dtype=np.float64)[:, :2] - np.asarray(smoothed)[:, :2]
    mag2 = (jitter ** 2).sum(axis=1)
    if len(mag2) == 0:
        return [], 0.0, 0.0
    second = (np.arange(len(mag2)) / fps).astype(int)
    per_second = [float(100.0 * math.sqrt(mag2[second == s].mean()) / width)
                  for s in range(second[-1] + 1)]
    return per_second, max(per_second), float(np.mean(per_second))


def warp_matrix(cx, cy, ca, zoom, width, height):
    """2x3 matrix: rotate by ca and translate by (cx, cy) about the centre, then zoom."""
    c = np.array([(width - 1) / 2.0, (height - 1) / 2.0])
    rot = np.array([[math.cos(ca), -math.sin(ca)], [math.sin(ca), math.cos(ca)]])
    lin = zoom * rot
    offset = c + zoom * np.array([cx, cy]) - lin @ c
    return np.hstack([lin, offset[:, None]])


def chroma_matrix(m):
    """The same warp for a 4:2:0 chroma plane (left-sited chroma: luma = 2 * chroma + (0, 0.5))."""
    o = np.array([0.0, 0.5])
    a, b = m[:, :2], m[:, 2]
    return np.hstack([a, ((a @ o + b - o) / 2)[:, None]])


# ---------------------------------------------------------------------------
# ffmpeg / ffprobe plumbing
# ---------------------------------------------------------------------------

def run_probe(args):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-of", "json"] + args,
                             check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise StabilizeError("ffprobe not found on PATH")
    except subprocess.CalledProcessError as e:
        raise StabilizeError("ffprobe failed: " + e.stderr.strip())
    return json.loads(out)


def count_frames(path):
    """Frames in the first video stream: container header, else count packets."""
    info = run_probe(["-select_streams", "v:0", "-show_entries", "stream=nb_frames", path])
    n = info["streams"][0].get("nb_frames") if info.get("streams") else None
    if n and n.isdigit() and int(n) > 0:
        return int(n)
    info = run_probe(["-select_streams", "v:0", "-count_packets",
                      "-show_entries", "stream=nb_read_packets", path])
    return int(info["streams"][0]["nb_read_packets"])


def probe(path):
    if not os.path.isfile(path):
        raise StabilizeError("input not found: " + path)
    info = run_probe(["-show_streams", "-show_format", path])
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        raise StabilizeError("no video stream in " + path)
    width, height = int(video["width"]), int(video["height"])
    rotation = 0
    for sd in video.get("side_data_list", []):
        rotation = int(float(sd.get("rotation", rotation)))
    if abs(rotation) % 180 == 90:  # ffmpeg autorotates on decode
        width, height = height, width
    fps = Fraction(video["r_frame_rate"])
    if fps <= 0:
        raise StabilizeError("cannot read frame rate of " + path)
    if video.get("avg_frame_rate") not in (None, "0/0") and Fraction(video["avg_frame_rate"]) != fps:
        print("warning: input looks variable-frame-rate (r=%s avg=%s); output is CFR at %s"
              % (video["r_frame_rate"], video["avg_frame_rate"], fps), file=sys.stderr)
    fmt_start = float(info["format"].get("start_time", 0) or 0)
    return {
        "width": width, "height": height, "fps": fps,
        "frames": count_frames(path),
        "duration": float(video.get("duration") or info["format"].get("duration") or 0),
        "video_offset": float(video.get("start_time", 0) or 0) - fmt_start,
        "color": {k: video.get(k) for k in ("color_space", "color_primaries", "color_transfer", "color_range")},
    }


def parse_crop(spec, width, height):
    if not spec:
        return None
    try:
        w, h, x, y = (int(v) for v in spec.split(":"))
    except ValueError:
        raise StabilizeError("--crop must be W:H:X:Y (integers), got " + spec)
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > width or y + h > height:
        raise StabilizeError("crop %s does not fit inside %dx%d" % (spec, width, height))
    return w, h, x, y


def geometry_filters(crop, mirror):
    """The crop + mirror both analyze and apply see, so they share one frame space."""
    filters = []
    if crop:
        filters.append("crop=%d:%d:%d:%d:exact=1" % crop)
    if mirror:
        filters.append("hflip")
    return filters


class FrameReader:
    """Decode frames from ffmpeg as flat uint8 arrays (one reused buffer, frame_size bytes)."""

    def __init__(self, path, filters, pix_fmt, frame_size, limit_seconds=None):
        self.size = frame_size
        self.buf = bytearray(self.size)
        self.err = tempfile.TemporaryFile()
        cmd = ["ffmpeg", "-nostdin", "-v", "error"] + HWACCEL + [
            "-i", path, "-map", "0:v:0", "-an", "-sn", "-dn"]
        if limit_seconds:
            cmd += ["-t", str(limit_seconds)]
        cmd += ["-vf", ",".join(filters), "-fps_mode", "passthrough",
                "-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=self.err)

    def __iter__(self):
        view = memoryview(self.buf)
        while True:
            got = 0
            while got < self.size:
                n = self.proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got == 0:
                break
            if got < self.size:
                raise StabilizeError("decoder returned a truncated frame")
            yield np.frombuffer(self.buf, dtype=np.uint8)
        if self.proc.wait() != 0:
            raise StabilizeError("ffmpeg decode failed: " + self.stderr())

    def stderr(self):
        self.err.seek(0)
        return self.err.read().decode(errors="replace").strip()[-2000:]

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.err.close()


class FrameWriter:
    """Feeds the encoder from a thread so pipe writes overlap the next frame's warp."""

    def __init__(self, pipe, depth=4):
        self.pipe, self.error = pipe, None
        self.queue = queue.Queue(maxsize=depth)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            frame = self.queue.get()
            if frame is None:
                break
            if self.error is None:
                try:
                    self.pipe.write(frame.data)
                except (BrokenPipeError, OSError) as e:
                    self.error = e  # keep draining so put() never blocks forever

    def put(self, frame):
        if self.error is not None:
            return False
        self.queue.put(frame)
        return True

    def close(self):
        if self.thread.is_alive():
            self.queue.put(None)
            self.thread.join()
        try:
            self.pipe.close()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Tracking
# ---------------------------------------------------------------------------

def speaker_mask(kind, width, height):
    """255 where background features may be tracked; the speaker's area is blanked out."""
    mask = np.full((height, width), 255, dtype=np.uint8)
    spans = {"center": (0.28, 0.72), "left": (0.10, 0.55), "right": (0.45, 0.90)}
    if kind in spans:
        x0, x1 = (int(round(f * width)) for f in spans[kind])
        mask[int(round(0.12 * height)):, x0:x1] = 0  # keep the strip above the head
    return mask


def estimate_motion(prev, cur, mask):
    """Background motion prev -> cur as (dx, dy, da) of the frame centre, or None."""
    pts = cv2.goodFeaturesToTrack(prev, maxCorners=300, qualityLevel=0.01,
                                  minDistance=8, blockSize=3, mask=mask)
    if pts is None or len(pts) < 8:
        return None
    nxt, status, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
    ok = status.ravel() == 1
    if ok.sum() < 8:
        return None
    m, inliers = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC,
                                             ransacReprojThreshold=2.0)
    if m is None or inliers is None or inliers.sum() < 8:
        return None
    # Express the motion about the frame centre, which is where apply rotates.
    h, w = prev.shape
    c = np.array([(w - 1) / 2.0, (h - 1) / 2.0])
    t = m[:, :2] @ c + m[:, 2] - c
    return t[0], t[1], math.atan2(m[1, 0], m[0, 0])


def track_motion(path, crop=None, mirror=False, mask="center", limit_seconds=None, meta=None):
    """Per-frame background motion in full-res (post-crop) pixels / radians.

    Returns (transforms N x 3, info) where transforms[0] is zero and info has
    width, height, fps, frames, failed (frames where estimation fell back to zero).
    """
    meta = meta or probe(path)
    crop = parse_crop(crop, meta["width"], meta["height"]) if isinstance(crop, str) else crop
    width, height = (crop[0], crop[1]) if crop else (meta["width"], meta["height"])
    tw = min(TRACK_WIDTH, width) // 2 * 2
    th = max(2, int(round(height * tw / width / 2.0)) * 2)
    sx, sy = width / float(tw), height / float(th)

    filters = geometry_filters(crop, mirror) + ["scale=%d:%d:flags=area" % (tw, th)]
    reader = FrameReader(path, filters, "gray", tw * th, limit_seconds)
    track_mask = speaker_mask(mask, tw, th)
    transforms, failed, prev = [], 0, None
    try:
        for frame in reader:
            frame = frame.reshape(th, tw)
            if prev is None:
                transforms.append((0.0, 0.0, 0.0))
            else:
                motion = estimate_motion(prev, frame, track_mask)
                if motion is None:
                    failed += 1
                    motion = (0.0, 0.0, 0.0)
                transforms.append((motion[0] * sx, motion[1] * sy, motion[2]))
            prev = frame.copy()
    finally:
        reader.close()

    frames = len(transforms)
    expected = meta["frames"]
    if limit_seconds:
        expected = min(expected, int(math.ceil(limit_seconds * meta["fps"] - 1e-6)))
        if abs(frames - expected) > 1:
            raise StabilizeError("decoded %d frames, expected about %d" % (frames, expected))
    elif frames != expected:
        raise StabilizeError("decoded %d frames but ffprobe reports %d" % (frames, expected))
    if frames < 2:
        raise StabilizeError("need at least 2 frames, got %d" % frames)
    return np.array(transforms), {"width": width, "height": height, "fps": meta["fps"],
                                  "frames": frames, "failed": failed}


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_analyze(args):
    if args.smooth <= 0:
        raise StabilizeError("--smooth must be > 0")
    if args.max_zoom < 1.0:
        raise StabilizeError("--max-zoom must be >= 1.0")
    meta = probe(args.input)
    crop = parse_crop(args.crop, meta["width"], meta["height"])
    t0 = time.time()
    transforms, info = track_motion(args.input, crop, args.mirror, args.mask, args.limit_seconds, meta)
    fps, width, height = float(info["fps"]), info["width"], info["height"]

    trajectory, smoothed, corrections = compute_corrections(transforms, fps, args.smooth)
    zoom, corrections, clamped = fit_zoom(corrections, width, height, args.max_zoom)
    per_second, peak, mean = shake_profile(trajectory, smoothed, fps, width)

    result = {
        "version": VERSION,
        "fps": round(fps, 6),
        "frames": info["frames"],
        "width": width,
        "height": height,
        "crop": args.crop if crop else None,
        "mirror": bool(args.mirror),
        "mask": args.mask,
        "smooth": args.smooth,
        # Round up so rounding never exposes a border.
        "zoom": math.ceil(zoom * 1e5) / 1e5,
        "corrections": [[round(c[0], 3), round(c[1], 3), round(c[2], 6)] for c in corrections.tolist()],
        "shakePerSecond": [round(s, 4) for s in per_second],
        "peakShake": round(peak, 4),
        "meanShake": round(mean, 4),
    }
    tmp = args.output + ".part"
    with open(tmp, "w") as f:
        json.dump(result, f, separators=(",", ":"))
    os.replace(tmp, args.output)

    elapsed = time.time() - t0
    peak_at = int(np.argmax(per_second))
    print("analyzed %d frames (%.1fs) in %.1fs (%.1fx realtime): zoom %.4f, peakShake %.3f%% at %ds, "
          "meanShake %.3f%%, clamped %d, track failures %d"
          % (info["frames"], info["frames"] / fps, elapsed, info["frames"] / fps / max(elapsed, 1e-9),
             result["zoom"], peak, peak_at, mean, clamped, info["failed"]), flush=True)


def cmd_apply(args):
    try:
        with open(args.analysis) as f:
            a = json.load(f)
    except (OSError, ValueError) as e:
        raise StabilizeError("cannot read analysis %s: %s" % (args.analysis, e))
    if a.get("version") != VERSION:
        raise StabilizeError("unsupported analysis version: %r" % a.get("version"))
    meta = probe(args.input)
    fps = meta["fps"]
    if abs(float(fps) - a["fps"]) > 1e-3:
        raise StabilizeError("analysis fps %s does not match input fps %s" % (a["fps"], fps))
    if meta["frames"] != a["frames"]:
        raise StabilizeError("analysis covers %d frames but the input has %d (was it analyzed with "
                             "--limit-seconds or on another file?)" % (a["frames"], meta["frames"]))
    crop = parse_crop(a.get("crop"), meta["width"], meta["height"])
    width, height = (crop[0], crop[1]) if crop else (meta["width"], meta["height"])
    if (width, height) != (a["width"], a["height"]):
        raise StabilizeError("analysis frame size %dx%d does not match input %dx%d"
                             % (a["width"], a["height"], width, height))
    corrections, zoom, frames = a["corrections"], float(a["zoom"]), a["frames"]
    if len(corrections) != frames:
        raise StabilizeError("analysis has %d corrections for %d frames" % (len(corrections), frames))

    if width % 2 or height % 2:
        raise StabilizeError("frame size %dx%d must be even for yuv420p" % (width, height))

    # Warp the YUV planes directly: no RGB round trip, so colours are untouched and
    # there is half the data to move. Tags are copied from the input.
    tags = meta["color"]
    decode_filters = geometry_filters(crop, a.get("mirror")) + ["format=yuv420p"]
    part = args.output + ".part.mp4"
    enc_cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "%dx%d" % (width, height),
               "-framerate", str(fps)]
    if abs(meta["video_offset"]) > 1e-6:  # keep the original A/V offset
        enc_cmd += ["-itsoffset", "%.6f" % meta["video_offset"]]
    # Tag in the graph: ffmpeg takes colour tags from the frames, not from -color_* flags.
    tag_filter = "setparams=range=%s:color_primaries=%s:color_trc=%s:colorspace=%s" % (
        "pc" if tags.get("color_range") == "pc" else "tv", tags.get("color_primaries") or "bt709",
        tags.get("color_transfer") or "bt709", tags.get("color_space") or "bt709")
    enc_cmd += ["-i", "pipe:0", "-i", args.input, "-map", "0:v:0", "-map", "1:a?", "-vf", tag_filter]
    enc_cmd += CODECS[args.codec]
    enc_cmd += ["-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-r", str(fps),
                "-c:a", "copy", "-movflags", "+faststart", part]

    luma, chroma = width * height, (width // 2) * (height // 2)
    planes = ((0, width, height), (luma, width // 2, height // 2), (luma + chroma, width // 2, height // 2))

    def warp(frame, m):
        out = np.empty_like(frame)
        mc = chroma_matrix(m)
        for i, (off, w, h) in enumerate(planes):
            size = w * h
            cv2.warpAffine(frame[off:off + size].reshape(h, w), m if i == 0 else mc, (w, h),
                           dst=out[off:off + size].reshape(h, w), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE)
        return out

    t0 = time.time()
    reader = FrameReader(args.input, decode_filters, "yuv420p", luma + 2 * chroma)
    enc_err = tempfile.TemporaryFile()
    encoder = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=enc_err)
    writer = FrameWriter(encoder.stdin)
    written, last = 0, -1
    try:
        for frame in reader:
            if written >= frames:
                raise StabilizeError("input decoded to more than the %d analyzed frames" % frames)
            cx, cy, ca = corrections[written]
            m = warp_matrix(cx, cy, ca, zoom, width, height)
            if not writer.put(warp(frame, m)):
                break  # encoder stopped reading; its exit code and stderr say why
            written += 1
            pct = written * 100 // frames
            if pct != last:
                last = pct
                print("progress %.2f" % (written / frames), flush=True)
        writer.close()
        if encoder.wait() != 0:
            enc_err.seek(0)
            raise StabilizeError("ffmpeg encode failed: " + enc_err.read().decode(errors="replace").strip()[-2000:])
        if writer.error:
            raise StabilizeError("writing to the encoder failed: %s" % writer.error)
        if written != frames:
            raise StabilizeError("wrote %d frames, analysis has %d" % (written, frames))
        out_frames = count_frames(part)
        if out_frames != frames:
            raise StabilizeError("output has %d frames, expected %d" % (out_frames, frames))
        os.replace(part, args.output)
    except BaseException:
        if encoder.poll() is None:
            encoder.kill()
            encoder.wait()
        writer.close()
        if os.path.exists(part):
            os.remove(part)
        raise
    finally:
        reader.close()
        enc_err.close()

    elapsed = time.time() - t0
    seconds = frames / float(fps)
    print("stabilized %d frames (%.1fs) in %.1fs (%.2fx realtime), zoom %.4f -> %s"
          % (frames, seconds, elapsed, seconds / max(elapsed, 1e-9), zoom, args.output), flush=True)


def main(argv=None):
    p = argparse.ArgumentParser(description="Tripod-style stabilization for talking-head recordings.")
    sub = p.add_subparsers(dest="command", required=True)

    an = sub.add_parser("analyze", help="track camera shake and write corrections JSON")
    an.add_argument("input")
    an.add_argument("output", help="analysis JSON path")
    an.add_argument("--crop", help="W:H:X:Y crop applied before tracking (same as apply)")
    an.add_argument("--mirror", action="store_true", help="hflip after the crop")
    an.add_argument("--mask", choices=MASKS, default="center", help="where the speaker sits (excluded from tracking)")
    an.add_argument("--smooth", type=float, default=1.0, help="Gaussian sigma of the camera path, seconds")
    an.add_argument("--max-zoom", type=float, default=1.06, help="zoom cap used to hide borders")
    an.add_argument("--limit-seconds", type=float, help="only analyze the first S seconds (diagnostics)")
    an.set_defaults(func=cmd_analyze)

    ap = sub.add_parser("apply", help="warp the video with an analysis JSON")
    ap.add_argument("input")
    ap.add_argument("analysis")
    ap.add_argument("output")
    ap.add_argument("--codec", choices=sorted(CODECS), default="hevc")
    ap.set_defaults(func=cmd_apply)

    args = p.parse_args(argv)
    try:
        args.func(args)
    except (StabilizeError, OSError) as e:
        print("stabilize: error: %s" % e, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("stabilize: interrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
