// Title (editable), framing, end-card title, Review/Output tabs, undo/redo and the save indicator.
import { useEffect, useState } from "react";
import { useProject } from "../state/ProjectProvider.tsx";
import { canRedo, canUndo } from "../lib/history.ts";
import { navigate } from "../lib/router.ts";
import { FramingControl } from "./FramingControl.tsx";
import { SaveIndicator } from "./SaveIndicator.tsx";
import { ShortcutsButton } from "./ShortcutsButton.tsx";
import { Icon } from "./Icon.tsx";
import { MockChip } from "./MockChip.tsx";
import type { View } from "./ProjectScreen.tsx";

export function ProjectHeader({ view, onView }: { view: View; onView: (v: View) => void }) {
  const { state, patchProject, undo, redo } = useProject();
  const project = state.bundle!.project;

  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-pane px-3">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/")} aria-label="Back to projects">
        <Icon name="back" size={14} />
        Projects
      </button>
      <span className="text-faint" aria-hidden="true">
        /
      </span>
      <CommitField
        label="Project title"
        value={project.title}
        onCommit={(title) => title.trim() && patchProject({ title: title.trim() })}
        className="min-w-[160px] max-w-[420px] flex-1 border-transparent bg-transparent text-[13.5px] font-semibold hover:border-line"
      />

      <MockChip />
      <div role="tablist" aria-label="Project views" className="seg ml-2">
        {(["review", "output"] as const).map((v) => (
          <button key={v} type="button" role="tab" id={`tab-${v}`} aria-controls={`panel-${v}`} aria-selected={view === v} onClick={() => onView(v)}>
            {v === "review" ? "Review" : "Output"}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <FramingControl compact value={project.speakerSide} onChange={(speakerSide) => patchProject({ speakerSide })} />
        <label className="flex items-center gap-2" title="Shown on the end card">
          <span className="meta">Next video</span>
          <CommitField
            label="Next video title (end card)"
            value={project.nextVideoTitle}
            placeholder="Title for the end card"
            onCommit={(nextVideoTitle) => patchProject({ nextVideoTitle: nextVideoTitle.trim() })}
            className="w-48"
          />
        </label>
        <span className="h-5 w-px bg-line" aria-hidden="true" />
        <div className="flex items-center">
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo(state.history)} onClick={undo}>
            <Icon name="undo" size={15} />
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo(state.history)} onClick={redo}>
            <Icon name="redo" size={15} />
          </button>
        </div>
        <SaveIndicator />
        <ShortcutsButton />
      </div>
    </header>
  );
}

/** A text input that commits on Enter or blur, and follows the server value while not being edited. */
function CommitField({
  value,
  onCommit,
  label,
  placeholder,
  className = "",
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return (
    <input
      aria-label={label}
      className={`field ${className}`}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}
