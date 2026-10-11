// Timeline geometry: seconds <-> pixels, frame snapping, zoom, ruler ticks, timecodes. Pure.

export const MIN_PPS = 1; // pixels per second, fully zoomed out
export const MAX_PPS = 480; // fully zoomed in (16 px per frame at 30 fps)
export const ZOOM_FACTOR = 1.25;

export const secToPx = (t: number, pps: number) => t * pps;
export const pxToSec = (px: number, pps: number) => px / pps;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Nearest frame boundary, in seconds. */
export const snapToFrame = (t: number, fps: number) => Math.round(t * fps) / fps;

/** Milliseconds snapped to whole frames (1 frame = 1000/fps ms), rounded to 0.001 ms to keep JSON tidy. */
export function snapMs(ms: number, fps: number): number {
  const frame = 1000 / fps;
  return round3(Math.round(ms / frame) * frame) || 0; // || 0 turns -0 into 0
}

export const clampZoom = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));

/** One zoom step in or out (dir > 0 zooms in). */
export const zoomStep = (pps: number, dir: number) => clampZoom(pps * ZOOM_FACTOR ** Math.sign(dir));

/** Zoom that fits `duration` seconds into `width` pixels. */
export const fitZoom = (duration: number, width: number) => clampZoom(duration > 0 ? width / duration : 40);

/** scrollLeft that keeps time `t` under the same screen x after zooming to `pps`. */
export const scrollForZoom = (t: number, xInView: number, pps: number) => Math.max(0, t * pps - xInView);

const TICK_STEPS = [1 / 30, 2 / 30, 5 / 30, 10 / 30, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Major and minor tick times between `from` and `to` for a zoom level; majors are >= ~90 px apart. */
export function rulerTicks(pps: number, from: number, to: number): { step: number; major: number[]; minor: number[] } {
  const step = TICK_STEPS.find((s) => s * pps >= 90) ?? TICK_STEPS.at(-1)!;
  const sub = step >= 60 ? 6 : step >= 10 ? 5 : step >= 1 ? 4 : 2;
  const minorStep = step / sub;
  const major: number[] = [];
  const minor: number[] = [];
  const start = Math.max(0, Math.floor(from / step) * step);
  for (let t = start; t <= to + 1e-9; t += step) {
    major.push(round3(t));
    for (let k = 1; k < sub; k++) {
      const m = t + k * minorStep;
      if (m <= to) minor.push(round3(m));
    }
  }
  return { step, major, minor };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** MM:SS:FF (H:MM:SS:FF past an hour), output time. */
export function formatTimecode(t: number, fps: number): string {
  const total = Math.max(0, Math.round(t * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const body = `${pad(m)}:${pad(s % 60)}:${pad(f)}`;
  return h ? `${h}:${body}` : body;
}

/** m:ss for ruler labels and chapters; adds tenths when `precise`. */
export function formatClock(t: number, precise = false): string {
  const neg = t < 0;
  let x = Math.abs(t);
  if (!precise) x = Math.floor(x + 1e-6);
  const m = Math.floor(x / 60);
  const s = x - m * 60;
  const ss = precise ? s.toFixed(1).padStart(4, "0") : pad(Math.floor(s));
  return `${neg ? "-" : ""}${m}:${ss}`;
}

/** Ruler label for a tick: drops frames on coarse steps. */
export function formatTick(t: number, step: number, fps: number): string {
  if (step >= 1) return formatClock(t);
  const frame = Math.round((t - Math.floor(t + 1e-9)) * fps);
  return frame === 0 ? formatClock(t) : `${frame}f`;
}

/** "0.42 s", "12.3 s", "1:04" */
export function formatSeconds(sec: number): string {
  if (sec < 10) return `${sec.toFixed(2)} s`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  return formatClock(sec);
}
