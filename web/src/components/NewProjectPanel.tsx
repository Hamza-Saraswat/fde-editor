// New project: script -> recordings -> framing -> Create (POST /api/projects, which starts the import).
import { useState, type ReactNode } from "react";
import type { FileEntry, Project, ScriptEntry, SpeakerSide } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { formatBytes } from "../lib/format.ts";
import { ScriptPicker } from "./ScriptPicker.tsx";
import { FileBrowser } from "./FileBrowser.tsx";
import { FramingControl } from "./FramingControl.tsx";
import { Icon } from "./Icon.tsx";

export function NewProjectPanel({ onCancel, onCreated }: { onCancel: () => void; onCreated: (p: Project) => void }) {
  const { client } = useApp();
  const [script, setScript] = useState<ScriptEntry | null>(null);
  const [clips, setClips] = useState<FileEntry[]>([]);
  const [side, setSide] = useState<SpeakerSide>("left");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (f: FileEntry) => setClips((cs) => (cs.some((c) => c.path === f.path) ? cs.filter((c) => c.path !== f.path) : [...cs, f]));
  const move = (i: number, d: number) =>
    setClips((cs) => {
      const j = i + d;
      if (j < 0 || j >= cs.length) return cs;
      const next = cs.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const create = async () => {
    if (!script || !clips.length) return;
    setBusy(true);
    setError(null);
    try {
      const p = await client.createProject({ scriptPath: script.path, title: title.trim() || undefined, speakerSide: side, clipPaths: clips.map((c) => c.path) });
      onCreated(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="new-project-heading" className="mb-8 rounded-lg border border-line bg-pane">
      <header className="flex items-center border-b border-line px-4 py-3">
        <h2 id="new-project-heading" className="text-[14px] font-semibold">
          New project
        </h2>
        <button type="button" className="btn btn-sm btn-ghost btn-icon ml-auto" aria-label="Close new project" onClick={onCancel}>
          <Icon name="close" size={14} />
        </button>
      </header>

      <ol className="grid gap-6 px-4 py-4">
        <Step n={1} title="Script" done={!!script}>
          <ScriptPicker value={script} onChange={setScript} />
          <label className="mt-3 flex items-center gap-3">
            <span className="meta w-28 flex-none">Project title</span>
            <input className="field flex-1" placeholder={script?.title ?? "Defaults to the script's title"} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </Step>

        <Step n={2} title="Recordings" done={clips.length > 0}>
          <FileBrowser kind="video" label="Recordings" selected={clips.map((c) => c.path)} onToggle={toggle} />
          {clips.length > 0 && (
            <div className="mt-3">
              <p className="meta mb-1.5">In recording order. The edit follows the script, so order only breaks ties.</p>
              <ol aria-label="Selected recordings" className="grid gap-1">
                {clips.map((c, i) => (
                  <li key={c.path} className="flex items-center gap-2 rounded-md bg-sunken px-2 py-1 text-[12.5px]">
                    <span className="tc w-5 text-muted">{i + 1}</span>
                    <Icon name="film" size={14} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="meta">{formatBytes(c.size)}</span>
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Move ${c.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="up" size={13} />
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Move ${c.name} later`} disabled={i === clips.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="up" size={13} className="rotate-180" />
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${c.name}`} onClick={() => toggle(c)}>
                      <Icon name="close" size={13} />
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Step>

        <Step n={3} title="Framing" done>
          <FramingControl value={side} onChange={setSide} showHint />
        </Step>
      </ol>

      <footer className="flex items-center gap-3 border-t border-line px-4 py-3">
        {error && (
          <p role="alert" className="text-[12.5px] text-bad">
            {error}
          </p>
        )}
        <span className="meta ml-auto">{!script ? "Pick a script." : !clips.length ? "Pick at least one recording." : "Creating the project starts the import."}</span>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!script || !clips.length || busy} onClick={create}>
          {busy ? "Creating…" : "Create project"}
        </button>
      </footer>
    </section>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_1fr] gap-x-3">
      <span
        className={`grid h-6 w-6 place-items-center rounded-full text-[11.5px] font-semibold ${done ? "bg-accent-soft text-accent" : "border border-line-strong text-muted"}`}
        aria-hidden="true"
      >
        {n}
      </span>
      <div>
        <h3 className="mb-2 mt-0.5 text-[13px] font-semibold">{title}</h3>
        {children}
      </div>
    </li>
  );
}
