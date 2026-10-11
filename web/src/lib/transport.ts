// Playback controller for the player: wraps the preview <video>, or a virtual clock when there is
// no preview file yet (so the playhead, overlays and transcript follow still work). Handles J/K/L
// shuttle, including reverse, which HTML video can't do natively.

export type TransportSnapshot = { time: number; playing: boolean; rate: number }; // rate < 0 = reverse

const SHUTTLE_RATES = [1, 2, 4, 8];

export class Transport {
  private el: HTMLMediaElement | null = null;
  private vt = 0; // virtual time / reverse-play time
  private rate = 0; // 0 = paused
  private raf = 0;
  private lastTs = 0;
  private lastSeekAt = 0;
  private listeners = new Set<() => void>();
  private snap: TransportSnapshot = { time: 0, playing: false, rate: 0 };
  private detach: (() => void) | null = null;
  duration = 0;
  fps = 30;

  attach(el: HTMLMediaElement | null) {
    if (el === this.el) return;
    this.detach?.();
    this.detach = null;
    const t = this.time;
    this.el = el;
    this.vt = t;
    if (!el) {
      if (this.rate > 0) this.loop();
      this.emit();
      return;
    }
    const sync = () => {
      if (this.rate >= 0) this.vt = el.currentTime;
      this.emit();
    };
    const onPause = () => {
      if (this.rate > 0) {
        this.rate = 0;
        this.emit();
      }
    };
    const onEnded = () => {
      this.rate = 0;
      this.emit();
    };
    // a new src (preview rebuilt) starts at 0: put the playhead back where it was
    const restore = () => {
      if (Math.abs(el.currentTime - this.vt) > 0.01) el.currentTime = Math.min(this.vt, Number.isFinite(el.duration) ? el.duration : this.vt);
      this.emit();
    };
    el.addEventListener("seeked", sync);
    el.addEventListener("loadedmetadata", restore);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    this.detach = () => {
      el.removeEventListener("seeked", sync);
      el.removeEventListener("loadedmetadata", restore);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
    this.emit();
  }

  get time(): number {
    if (this.el && this.rate >= 0 && this.el.readyState > 0) return this.el.currentTime;
    return this.vt;
  }

  get playing() {
    return this.rate !== 0;
  }

  get playbackRate() {
    return this.rate;
  }

  private maxTime() {
    const d = this.el && Number.isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : this.duration;
    return Math.max(0, d);
  }

  play(rate = 1) {
    this.rate = rate;
    const el = this.el;
    if (el && el.readyState > 0 && rate > 0) {
      el.playbackRate = rate;
      if (el.currentTime >= this.maxTime() - 0.01) el.currentTime = 0;
      void el.play().catch(() => {
        this.rate = 0;
        this.emit();
      });
    } else {
      if (el && !el.paused) el.pause();
      if (rate > 0 && this.vt >= this.maxTime() - 0.01) this.vt = 0;
    }
    this.lastTs = 0;
    this.loop();
    this.emit();
  }

  pause() {
    if (this.el && this.rate < 0) this.el.currentTime = this.vt;
    this.rate = 0;
    if (this.el && !this.el.paused) this.el.pause();
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(1);
  }

  seek(t: number) {
    const x = Math.min(Math.max(0, t), this.maxTime() || Math.max(0, t));
    this.vt = x;
    if (this.el && this.el.readyState > 0) this.el.currentTime = x;
    this.emit();
  }

  stepFrames(n: number) {
    if (this.playing) this.pause();
    const f = Math.round(this.time * this.fps) + n;
    this.seek(f / this.fps);
  }

  /** J/K/L: L plays forward and speeds up on repeat, J the same in reverse, K stops. */
  shuttle(key: "j" | "k" | "l") {
    if (key === "k") return this.pause();
    const dir = key === "l" ? 1 : -1;
    const speed = Math.abs(this.rate);
    const sameDir = Math.sign(this.rate) === dir;
    const next = sameDir ? (SHUTTLE_RATES.find((r) => r > speed) ?? SHUTTLE_RATES.at(-1)!) : 1;
    if (dir < 0) this.vt = this.time;
    this.play(dir * next);
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    const tick = (ts: number) => {
      if (this.rate === 0) return;
      const dt = this.lastTs ? Math.min(0.1, (ts - this.lastTs) / 1000) : 0;
      this.lastTs = ts;
      const el = this.el;
      const virtual = !el || el.readyState === 0 || this.rate < 0;
      if (virtual) {
        this.vt += dt * this.rate;
        const end = this.maxTime();
        if ((this.rate < 0 && this.vt <= 0) || (this.rate > 0 && end > 0 && this.vt >= end)) {
          this.vt = Math.min(Math.max(0, this.vt), end);
          this.rate = 0;
        }
        // reverse on a real video: seek it along, throttled so the decoder keeps up
        if (el && el.readyState > 0 && ts - this.lastSeekAt > 60) {
          el.currentTime = this.vt;
          this.lastSeekAt = ts;
        }
      } else {
        this.vt = el.currentTime;
      }
      this.emit();
      if (this.rate !== 0) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private emit() {
    this.snap = { time: this.time, playing: this.playing, rate: this.rate };
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  /** Stop and let go of the element. Safe to call more than once (StrictMode mounts twice in dev). */
  dispose() {
    cancelAnimationFrame(this.raf);
    this.rate = 0;
    this.detach?.();
    this.detach = null;
    this.el = null;
  }
}
