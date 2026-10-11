// Pick the markdown script (GET /api/scripts).
import { useEffect, useState } from "react";
import type { ScriptEntry } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { formatDate } from "../lib/format.ts";

export function ScriptPicker({ value, onChange }: { value: ScriptEntry | null; onChange: (s: ScriptEntry) => void }) {
  const { client, config } = useApp();
  const [scripts, setScripts] = useState<ScriptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    client.scripts().then(setScripts, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  if (error) return <p role="alert" className="text-[12.5px] text-bad">Couldn't list scripts: {error}</p>;
  if (!scripts) return <p className="meta">Looking for scripts…</p>;
  if (!scripts.length) return <p className="meta">No scripts found in {config?.scriptsDir ?? "the scripts folder"}.</p>;

  const q = filter.trim().toLowerCase();
  const shown = q ? scripts.filter((s) => `${s.title} ${s.folder}`.toLowerCase().includes(q)) : scripts;

  return (
    <div>
      {scripts.length > 6 && (
        <input className="field mb-2 w-full" placeholder="Filter scripts" aria-label="Filter scripts" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      <div role="radiogroup" aria-label="Script" className="max-h-56 overflow-auto rounded-md border border-line">
        {shown.map((s) => {
          const on = value?.path === s.path;
          return (
            <button
              key={s.path}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(s)}
              className={`flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 ${on ? "bg-accent-soft" : "bg-sunken hover:bg-raised"}`}
            >
              <span className={`h-3.5 w-3.5 flex-none rounded-full border ${on ? "border-accent bg-accent shadow-[inset_0_0_0_3px_var(--color-sunken)]" : "border-line-strong"}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{s.title}</span>
                <span className="meta block truncate">{s.folder}</span>
              </span>
              <span className="meta flex-none">{formatDate(s.modified)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
