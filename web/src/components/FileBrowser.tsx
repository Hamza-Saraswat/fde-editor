// A small file browser over GET /api/files: navigate folders, multi-select matching files.
import { useEffect, useState } from "react";
import type { FileEntry, FileListing } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { formatBytes, formatDate } from "../lib/format.ts";
import { Icon } from "./Icon.tsx";

export function FileBrowser({
  kind,
  selected,
  onToggle,
  label,
}: {
  kind: "video" | "image";
  selected: string[];
  onToggle: (f: FileEntry) => void;
  label: string;
}) {
  const { client } = useApp();
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    client.files(dir, kind).then(
      (l) => {
        if (!live) return;
        setListing(l);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, dir, kind]);

  const crumbs = listing ? listing.dir.split("/").filter(Boolean) : [];

  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          type="button"
          className="btn btn-sm btn-ghost btn-icon"
          aria-label="Up one folder"
          title="Up one folder"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && setDir(listing.parent)}
        >
          <Icon name="up" size={14} />
        </button>
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12px]">
          {crumbs.map((c, i) => {
            const path = "/" + crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <span key={path} className="flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  className={`truncate rounded px-1 ${last ? "text-ink" : "text-muted hover:text-ink"}`}
                  onClick={() => setDir(path)}
                  aria-current={last ? "location" : undefined}
                  disabled={last}
                >
                  {c}
                </button>
                {!last && <span className="text-faint">/</span>}
              </span>
            );
          })}
        </nav>
        {loading && <span className="meta">Loading…</span>}
      </div>
      {error && <p role="alert" className="px-3 py-3 text-[12.5px] text-bad">{error}</p>}
      <ul role="listbox" aria-label={label} aria-multiselectable="true" className="max-h-64 overflow-auto">
        {listing?.entries.length === 0 && <li className="meta px-3 py-3">No folders or {kind === "video" ? "videos" : "images"} here.</li>}
        {listing?.entries.map((f) => {
          const on = selected.includes(f.path);
          const order = selected.indexOf(f.path) + 1;
          return (
            <li key={f.path} role="option" aria-selected={f.isDir ? undefined : on}>
              <button
                type="button"
                onClick={() => (f.isDir ? setDir(f.path) : onToggle(f))}
                className={`grid w-full grid-cols-[20px_1fr_80px_130px] items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${on ? "bg-accent-soft" : "hover:bg-raised"}`}
                aria-label={f.isDir ? `Open folder ${f.name}` : `${on ? "Deselect" : "Select"} ${f.name}`}
              >
                {f.isDir ? (
                  <Icon name="folder" size={15} className="text-muted" />
                ) : on ? (
                  <span className="grid h-4 w-4 place-items-center rounded bg-accent text-[10px] font-semibold text-accent-ink">{order}</span>
                ) : (
                  <span className="h-4 w-4 rounded border border-line-strong" />
                )}
                <span className={`truncate ${f.isDir ? "text-ink-2" : "text-ink"}`}>{f.name}</span>
                <span className="meta text-right">{f.isDir ? "" : formatBytes(f.size)}</span>
                <span className="meta text-right">{formatDate(f.modified, true)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
