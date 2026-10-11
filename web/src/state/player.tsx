// Shared playback: one Transport per project screen, plus "play this take from the source recording".
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Transport, type TransportSnapshot } from "../lib/transport.ts";

export type SourcePreview = { clipId: string; start: number; end: number; label: string; text: string };

type PlayerApi = {
  transport: Transport;
  sourcePreview: SourcePreview | null;
  playSource: (p: SourcePreview) => void;
  closeSource: () => void;
};

const Ctx = createContext<PlayerApi | null>(null);

export function PlayerProvider({ fps, duration, children }: { fps: number; duration: number; children: ReactNode }) {
  const transport = useMemo(() => new Transport(), []);
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  transport.fps = fps;
  transport.duration = duration;
  useEffect(() => () => transport.dispose(), [transport]);
  const api = useMemo<PlayerApi>(
    () => ({
      transport,
      sourcePreview,
      playSource: (p) => {
        transport.pause();
        setSourcePreview(p);
      },
      closeSource: () => setSourcePreview(null),
    }),
    [transport, sourcePreview],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlayer outside PlayerProvider");
  return v;
}

/** Re-renders on every playhead change (up to once per animation frame while playing). */
export function usePlayhead(): TransportSnapshot {
  const { transport } = usePlayer();
  return useSyncExternalStore(transport.subscribe, transport.getSnapshot);
}
