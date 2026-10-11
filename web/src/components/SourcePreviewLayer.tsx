// Plays a take that isn't in the cut, straight from the clip's 720p proxy.
import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { formatSeconds } from "../lib/timelineMath.ts";
import { Icon } from "./Icon.tsx";

export function SourcePreviewLayer() {
  const { client } = useApp();
  const { slug } = useProject();
  const { sourcePreview: sp, closeSource } = usePlayer();
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setError(false);
    setProgress(0);
  }, [sp]);

  if (!sp) return null;
  const src = client.mediaUrl(slug, `proxy/${sp.clipId}.mp4`);
  const len = sp.end - sp.start;

  return (
    <div className="absolute inset-0 bg-black" role="dialog" aria-label={`Playing ${sp.label} from the source recording`}>
      {!error && (
        <video
          ref={ref}
          src={`${src}#t=${sp.start.toFixed(2)}`}
          className="absolute inset-0 h-full w-full"
          autoPlay
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            v.currentTime = sp.start;
            void v.play().catch(() => {});
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress(Math.min(1, Math.max(0, (v.currentTime - sp.start) / len)));
            if (v.currentTime >= sp.end) {
              v.pause();
              closeSource();
            }
          }}
          onError={() => setError(true)}
        />
      )}
      <div className="absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/85 to-transparent px-3 pb-6 pt-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-ink">
            {sp.label}, from the source recording ({sp.clipId}, {formatSeconds(len)})
          </p>
          <p className="mt-0.5 line-clamp-2 font-serif text-[13px] text-ink-2">{sp.text}</p>
          {error && <p className="mt-1 text-[12px] text-warn">Couldn't load the proxy for {sp.clipId} (proxy/{sp.clipId}.mp4). Run Import to rebuild it.</p>}
        </div>
        <button type="button" className="btn btn-sm pointer-events-auto" onClick={closeSource} aria-label="Stop the take preview">
          <Icon name="close" size={12} />
          Back to the cut
        </button>
      </div>
      {!error && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
