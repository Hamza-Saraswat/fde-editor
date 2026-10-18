// Picture fixes for one recording: mirror (a front camera saved a mirror image) and stabilize (table
// knocks shook the camera). Either one makes the server build a conformed master, then a new preview.
import { useState } from "react";
import { useApp } from "../state/app.tsx";
import { useProject } from "../state/ProjectProvider.tsx";
import type { Clip } from "../types.ts";
import { Switch } from "./Switch.tsx";

export function ClipFixes({ clip }: { clip: Clip }) {
  const { client } = useApp();
  const { slug, dispatch, notify } = useProject();
  const [busy, setBusy] = useState(false);
  const set = async (body: { mirror?: boolean; stabilize?: boolean }) => {
    setBusy(true);
    try {
      dispatch({ type: "project", project: await client.patchClip(slug, clip.id, body) });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
        Mirror
        <Switch checked={!!clip.mirror} disabled={busy} label={clip.mirror ? `Stop mirroring ${clip.name}` : `Mirror ${clip.name} (front camera)`} onChange={(mirror) => void set({ mirror })} />
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
        Stabilize
        <Switch checked={!!clip.stabilize} disabled={busy} label={clip.stabilize ? `Stop stabilizing ${clip.name}` : `Stabilize ${clip.name}`} onChange={(stabilize) => void set({ stabilize })} />
      </label>
    </span>
  );
}
