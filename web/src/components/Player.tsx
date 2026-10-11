// The A-roll preview (outputs.preview) with graphics laid over it in the page, timed from the
// timeline. Without a preview file the clock is simulated so timing can still be checked.
import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/app.tsx";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer, usePlayhead } from "../state/player.tsx";
import { runningJob } from "../state/projectStore.ts";
import { formatTimecode } from "../lib/timelineMath.ts";
import { OverlayLayer } from "./OverlayLayer.tsx";
import { SourcePreviewLayer } from "./SourcePreviewLayer.tsx";
import { Icon } from "./Icon.tsx";

export function Player() {
  const { state, runStage } = useProject();
  const { config } = useApp();
  const { transport, sourcePreview } = usePlayer();
  const { duration, fps } = useDerived();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);
  const [muted, setMuted] = useState(false);
  const b = state.bundle!;
  const aspect = config ? config.output.width / config.output.height : 16 / 9;

  const base = b.outputs.preview;
  const src = base ? `${base}${base.includes("?") ? "&" : "?"}v=${state.previewNonce}` : null;
  const rebuilding = !!runningJob(b, "preview") || b.project.stages.preview?.state === "running";
  // From data, not event order: the server records which edit version the preview was built from.
  const builtFor = b.outputs.previewEditVersion;
  const previewStale = builtFor !== undefined && b.edit ? builtFor !== b.edit.version : state.previewStale;

  useEffect(() => {
    setVideoError(false);
    transport.attach(src ? videoRef.current : null);
  }, [transport, src]);
  useEffect(() => () => transport.attach(null), [transport]);

  return (
    <section aria-label="Player" className="flex h-full flex-col">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-line bg-pane px-3">
        <h2 className="pane-title">Preview</h2>
        {rebuilding ? (
          <span className="flex items-center gap-1.5 text-[12px] text-run" role="status">
            <span className="dot" data-state="running" />
            Updating preview…
          </span>
        ) : previewStale ? (
          <span className="flex items-center gap-2 text-[12px] text-warn" role="status">
            The cut changed since this preview was built.
            <button type="button" className="btn btn-sm" onClick={() => runStage("preview")}>
              Update preview
            </button>
          </span>
        ) : !src ? (
          <span className="meta">No preview file yet. Playback is simulated so you can check timing.</span>
        ) : null}
      </div>

      {/* the frame, letterboxed to the output aspect */}
      <div className="relative min-h-0 flex-1" style={{ containerType: "size" }}>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[3px] bg-black shadow-[0_0_0_1px_var(--color-line)]"
          style={{ width: `min(calc(100cqw - 24px), calc((100cqh - 24px) * ${aspect}))`, aspectRatio: String(aspect) }}
        >
          {src ? (
            <video
              ref={videoRef}
              src={src}
              className="absolute inset-0 h-full w-full"
              preload="auto"
              playsInline
              muted={muted}
              onError={() => setVideoError(true)}
              onClick={() => transport.toggle()}
              aria-label="A-roll preview"
            />
          ) : (
            <SimulatedFrame />
          )}
          <OverlayLayer />
          {videoError && (
            <p role="alert" className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded bg-black/70 px-3 py-1.5 text-[12px] text-ink">
              Couldn't load preview.mp4. Run Preview to rebuild it.
            </p>
          )}
          {sourcePreview && <SourcePreviewLayer />}
          {rebuilding && src && <div className="pointer-events-none absolute inset-0 bg-black/25" aria-hidden="true" />}
        </div>
      </div>

      <Controls fps={fps} duration={duration} muted={muted} onMute={() => setMuted((m) => !m)} hasVideo={!!src} />
    </section>
  );
}

function SimulatedFrame() {
  const { state } = useProject();
  const side = state.bundle!.project.speakerSide;
  const x = side === "left" ? "33%" : side === "right" ? "67%" : "50%";
  return (
    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,#2a2f2d,#151817)]" aria-hidden="true">
      <svg viewBox="0 0 160 90" className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        <line x1="53.3" y1="0" x2="53.3" y2="90" stroke="#ffffff" strokeOpacity="0.05" />
        <line x1="106.6" y1="0" x2="106.6" y2="90" stroke="#ffffff" strokeOpacity="0.05" />
      </svg>
      <div className="absolute bottom-0 h-[78%] w-[24%] -translate-x-1/2" style={{ left: x }}>
        <div className="mx-auto mt-[6%] aspect-square w-[42%] rounded-full bg-[#3a403d]" />
        <div className="mx-auto mt-[4%] h-full w-full rounded-t-[45%] bg-[#3a403d]" />
      </div>
    </div>
  );
}

function Controls({ fps, duration, muted, onMute, hasVideo }: { fps: number; duration: number; muted: boolean; onMute: () => void; hasVideo: boolean }) {
  const { transport } = usePlayer();
  const snap = usePlayhead();
  const rate = snap.rate;
  return (
    <div className="flex h-11 flex-none items-center gap-1 border-t border-line bg-pane px-3">
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Back one frame" title="Back one frame (←)" onClick={() => transport.stepFrames(-1)}>
        <Icon name="frameBack" size={15} />
      </button>
      <button
        type="button"
        className="btn btn-icon h-8 w-8 rounded-full"
        aria-label={snap.playing ? "Pause" : "Play"}
        title={snap.playing ? "Pause (Space)" : "Play (Space)"}
        onClick={() => transport.toggle()}
      >
        <Icon name={snap.playing ? "pause" : "play"} size={15} />
      </button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Forward one frame" title="Forward one frame (→)" onClick={() => transport.stepFrames(1)}>
        <Icon name="frameFwd" size={15} />
      </button>
      <span className="tc ml-3 text-[13px] text-ink" aria-label="Playhead, output time">
        {formatTimecode(snap.time, fps)}
      </span>
      <span className="tc text-[12px] text-faint">/ {formatTimecode(duration, fps)}</span>
      {rate !== 0 && rate !== 1 && (
        <span className="tc ml-2 rounded bg-raised px-1.5 text-[11.5px] text-ink-2" aria-label={`Playing at ${rate}x`}>
          {rate > 0 ? `${rate}×` : `−${Math.abs(rate)}×`}
        </span>
      )}
      <span className="meta ml-auto hidden xl:inline">
        <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> shuttle
      </span>
      {hasVideo && (
        <button type="button" className="btn btn-sm btn-ghost btn-icon ml-2" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={onMute}>
          <Icon name={muted ? "mute" : "speaker"} size={15} />
        </button>
      )}
    </div>
  );
}
