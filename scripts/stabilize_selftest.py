#!/usr/bin/env python3
"""Self-test for stabilize.py: unit tests for the maths, then an end-to-end run
on a synthetic shaky clip (testsrc2 with per-frame jitter and decaying jolts).

  python3 scripts/stabilize_selftest.py [--workdir DIR] [--skip-video]

Prints PASS/FAIL per check; exits non-zero if anything fails.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stabilize as st  # noqa: E402

FAILURES = []


def check(name, ok, detail=""):
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, ("  (%s)" % detail) if detail else ""), flush=True)
    if not ok:
        FAILURES.append(name)


def transforms_from(trajectory):
    """Frame-to-frame motion whose cumulative sum is the given trajectory (row 0 = 0)."""
    traj = np.asarray(trajectory, dtype=np.float64)
    return np.vstack([np.zeros((1, traj.shape[1])), np.diff(traj, axis=0)])


# ---------------------------------------------------------------------------
# Unit tests (no video)
# ---------------------------------------------------------------------------

def test_maths():
    fps, w, h = 30.0, 1920, 1080

    # Zero motion: nothing to correct, no zoom.
    traj, sm, corr = st.compute_corrections(np.zeros((300, 3)), fps, 1.0)
    zoom, corr2, clamped = st.fit_zoom(corr, w, h, 1.06)
    _, peak, _ = st.shake_profile(traj, sm, fps, w)
    check("zero motion -> zero corrections, zoom 1.0",
          np.abs(corr2).max() == 0 and zoom == 1.0 and clamped == 0 and peak == 0,
          "max|c|=%g zoom=%g peak=%g" % (np.abs(corr2).max(), zoom, peak))

    # Constant drift (0.5 px/frame for 20 s): the path should be kept, not "corrected".
    n = 600
    drift = np.zeros((n, 3))
    drift[:, 0] = 0.5 * np.arange(n)
    traj, sm, corr = st.compute_corrections(transforms_from(drift), fps, 1.0)
    interior = np.abs(corr[120:n - 120, 0]).max()  # > 3 sigma from both edges
    kept = (sm[-1, 0] - sm[0, 0]) / (traj[-1, 0] - traj[0, 0])
    check("constant drift is preserved (interior corrections ~0, >80% of drift kept)",
          interior < 0.01 and kept > 0.8, "interior max|c|=%.4f px, kept=%.1f%%" % (interior, 100 * kept))

    # Single jolt: jump of 20 px at frame 150 that decays over ~4 frames.
    jolt = np.zeros((300, 3))
    k = np.arange(300) - 150
    jolt[:, 0] = np.where(k >= 0, 20.0 * np.exp(-np.maximum(k, 0) / 4.0), 0.0)
    jolt[:, 1] = 0.5 * jolt[:, 0]
    traj, sm, corr = st.compute_corrections(transforms_from(jolt), fps, 1.0)
    stabilized = traj + corr  # == smoothed path
    residual = np.abs(stabilized[:, :2]).max()
    step = np.abs(np.diff(stabilized[:, :2], axis=0)).max()
    per_second, peak, _ = st.shake_profile(traj, sm, fps, w)
    check("single jolt is removed (residual < 10% of jolt, no frame step > 0.2 px)",
          residual < 2.0 and step < 0.2, "residual=%.2f px step=%.3f px" % (residual, step))
    check("shake profile peaks in the jolt's second",
          int(np.argmax(per_second)) == 5 and peak > 0, "peak %.3f%% at %ds" % (peak, int(np.argmax(per_second))))

    # Clamping: a correction far beyond the zoom cap gets scaled down; small ones are untouched.
    corr = np.zeros((100, 3))
    corr[:, 0] = 5.0
    corr[40:45] = [200.0, -120.0, 0.05]
    zoom, clamped_corr, n_clamped = st.fit_zoom(corr, w, h, 1.06)
    worst = st.required_zoom(clamped_corr, w, h).max()
    untouched = np.allclose(clamped_corr[:40], corr[:40]) and np.allclose(clamped_corr[45:], corr[45:])
    check("clamping keeps zoom <= cap and leaves small corrections alone",
          zoom <= 1.06 and worst <= 1.06 + 1e-6 and n_clamped == 5 and untouched,
          "zoom=%.5f worst-needed=%.5f clamped=%d" % (zoom, worst, n_clamped))

    # Geometry: at the required zoom the output corners map exactly onto the source edge.
    rng = np.random.default_rng(1)
    ok, worst_gap = True, 0.0
    for _ in range(200):
        c = [rng.uniform(-60, 60), rng.uniform(-40, 40), rng.uniform(-0.02, 0.02)]
        z = float(st.required_zoom([c], w, h)[0])
        inv = np.linalg.inv(np.vstack([st.warp_matrix(c[0], c[1], c[2], z, w, h), [0, 0, 1]]))
        corners = np.array([[0, 0, 1], [w - 1, 0, 1], [0, h - 1, 1], [w - 1, h - 1, 1]], dtype=float)
        src = corners @ inv.T
        # Distance outside the source (positive = border would show); one corner should touch.
        out = np.maximum(np.maximum(-src[:, 0], src[:, 0] - (w - 1)),
                         np.maximum(-src[:, 1], src[:, 1] - (h - 1)))
        worst_gap = max(worst_gap, out.max())
        ok &= out.max() < 1e-6 and out.max() > -1e-6
    check("required_zoom matches warp_matrix geometry (corners land on the source edge)",
          ok, "worst overshoot %.2e px" % worst_gap)

    # Chroma: a pure shift halves on the 4:2:0 planes; a luma point maps to the same chroma point.
    m = st.warp_matrix(10.0, 6.0, 0.0, 1.0, w, h)
    mr = st.warp_matrix(4.0, -3.0, 0.01, 1.03, w, h)
    p_c = np.array([300.0, 200.0])  # chroma coords; luma = 2 * chroma + (0, 0.5)
    lhs = (mr[:, :2] @ (2 * p_c + [0, 0.5]) + mr[:, 2] - [0, 0.5]) / 2
    rhs = st.chroma_matrix(mr)[:, :2] @ p_c + st.chroma_matrix(mr)[:, 2]
    check("chroma_matrix matches the luma warp on 4:2:0 planes",
          np.allclose(st.chroma_matrix(m)[:, 2], [5.0, 3.0]) and np.allclose(lhs, rhs))


# ---------------------------------------------------------------------------
# End to end on a synthetic shaky clip
# ---------------------------------------------------------------------------

def make_shaky_clip(path):
    """A fake talking-head shot, 6 s at 30 fps with a sine tone, shaken by up to ~15 px.

    testsrc2 alone is a poor scene: nearly all of its corners belong to moving parts.
    So the "room" is a static textured still and the "speaker" is a live testsrc2
    pasted in the centre (excluded by --mask center). The shake is a small
    high-frequency wobble plus two decaying jolts, the 'hit the table' pattern.
    """
    room = path + ".room.png"
    texture = ("128+55*sin(X/7)*sin(Y/5)+45*sin((0.6*X+Y)/11)*cos((X-0.8*Y)/9)"
               "+25*sin(X/2.3+Y/3.1)*cos(Y/4.7)")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
                    "-i", "nullsrc=s=680x400:d=1,format=gray,geq=lum='%s'" % texture,
                    "-frames:v", "1", room], check=True)
    jx = ("20+3*sin(n*2.3)"
          "+12*exp(-4*(t-1.2))*sin(40*(t-1.2))*gte(t,1.2)"
          "+10*exp(-5*(t-3.5))*sin(33*(t-3.5))*gte(t,3.5)")
    jy = ("20+2*cos(n*1.9)"
          "+9*exp(-4*(t-1.2))*cos(40*(t-1.2))*gte(t,1.2)"
          "+8*exp(-5*(t-3.5))*cos(33*(t-3.5))*gte(t,3.5)")
    graph = ("[1:v]scale=240:330[speaker];[0:v][speaker]overlay=220:70:shortest=1,"
             "crop=640:360:'%s':'%s':exact=1,format=yuv420p[v]" % (jx, jy))
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y",
                    "-loop", "1", "-framerate", "30", "-t", "6", "-i", room,
                    "-f", "lavfi", "-i", "testsrc2=s=680x400:r=30:d=6",
                    "-f", "lavfi", "-i", "sine=f=440:d=6",
                    "-filter_complex", graph, "-map", "[v]", "-map", "2:a",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "12", "-r", "30",
                    "-c:a", "aac", "-shortest", "-movflags", "+faststart", path], check=True)
    os.remove(room)


def run_cli(*args):
    cmd = [sys.executable, os.path.join(HERE, "stabilize.py")] + list(args)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    lines = [l for l in proc.stdout.splitlines() if not l.startswith("progress ")]
    progress = sum(1 for l in proc.stdout.splitlines() if l.startswith("progress "))
    for l in lines:
        print("      " + l)
    if proc.returncode != 0:
        print("      " + proc.stderr.strip())
    return proc.returncode, progress


def rms_translation(transforms):
    t = np.asarray(transforms)[1:, :2]
    return float(np.sqrt((t ** 2).sum(axis=1).mean()))


def test_video(workdir):
    src = os.path.join(workdir, "shaky.mp4")
    analysis = os.path.join(workdir, "shaky.json")
    out = os.path.join(workdir, "shaky.stab.mp4")
    make_shaky_clip(src)

    code, _ = run_cli("analyze", src, analysis, "--mask", "center")
    check("analyze exits 0", code == 0)
    if code:
        return
    code, progress = run_cli("apply", src, analysis, out)
    check("apply exits 0 and reports progress", code == 0 and progress > 0, "%d progress lines" % progress)
    if code:
        return

    a, b = st.probe(src), st.probe(out)
    check("frame count identical", a["frames"] == b["frames"], "%d vs %d" % (a["frames"], b["frames"]))
    check("duration and fps identical",
          abs(a["duration"] - b["duration"]) < 1e-3 and a["fps"] == b["fps"],
          "%.4fs @ %s vs %.4fs @ %s" % (a["duration"], a["fps"], b["duration"], b["fps"]))
    audio = st.run_probe(["-select_streams", "a", "-show_entries", "stream=codec_name", out])["streams"]
    check("audio stream carried over", len(audio) == 1)

    before, _ = st.track_motion(src, mask="center")
    after, _ = st.track_motion(out, mask="center")
    rb, ra = rms_translation(before), rms_translation(after)
    drop = 1 - ra / rb if rb > 0 else 0
    check("frame-to-frame translation RMS drops > 80%", drop > 0.8,
          "%.2f px -> %.2f px (%.0f%% lower)" % (rb, ra, 100 * drop))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workdir", help="keep the synthetic clips here (default: temp dir, removed)")
    p.add_argument("--skip-video", action="store_true", help="unit tests only")
    args = p.parse_args()

    test_maths()
    if not args.skip_video:
        workdir = args.workdir or tempfile.mkdtemp(prefix="stabilize-selftest-")
        os.makedirs(workdir, exist_ok=True)
        try:
            test_video(workdir)
        finally:
            if not args.workdir:
                shutil.rmtree(workdir, ignore_errors=True)

    print("\n%s" % ("ALL PASS" if not FAILURES else "FAILED: " + ", ".join(FAILURES)))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
