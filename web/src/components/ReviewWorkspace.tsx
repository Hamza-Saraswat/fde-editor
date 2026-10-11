// The review screen: script + transcript (left), player (centre), inspector (right), timeline (bottom).
// Owns the global editing keys.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDerived, useProject } from "../state/ProjectProvider.tsx";
import { usePlayer } from "../state/player.tsx";
import { addUserCut, deleteCut } from "../lib/editOps.ts";
import { wordsBetween } from "../lib/words.ts";
import { ScriptPane } from "./ScriptPane.tsx";
import { TranscriptPane } from "./TranscriptPane.tsx";
import { Player } from "./Player.tsx";
import { Inspector } from "./Inspector.tsx";
import { Timeline } from "./Timeline.tsx";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable='true']");

export function ReviewWorkspace() {
  const { state, edit, apply, undo, redo, select } = useProject();
  const { idx } = useDerived();
  const { transport, sourcePreview, closeSource } = usePlayer();
  const [split, setSplit] = useState(0.42); // script share of the left column
  const leftCol = useRef<HTMLDivElement>(null);

  // the latest values for the window listener, without re-binding it on every change
  const live = useRef({ state, edit, idx, sourcePreview });
  live.current = { state, edit, idx, sourcePreview };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod || e.altKey) return;
      const { state: s, idx: ix, sourcePreview: sp } = live.current;
      switch (e.key) {
        case " ":
          e.preventDefault();
          // a focused button would also "click" on key-up: Space belongs to the player here
          if (e.target instanceof HTMLElement && e.target.closest("button, [role='button'], [role='radio'], [role='tab'], [role='switch']")) e.target.blur();
          if (sp) closeSource();
          transport.toggle();
          return;
        case "j":
        case "k":
        case "l":
        case "J":
        case "K":
        case "L":
          e.preventDefault();
          transport.shuttle(k as "j" | "k" | "l");
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          transport.stepFrames(dir * (e.shiftKey ? transport.fps : 1));
          return;
        }
        case "Backspace":
        case "Delete": {
          const sel = s.selection;
          if (sel?.kind === "words" && ix) {
            e.preventDefault();
            const words = wordsBetween(ix, sel.anchor, sel.focus);
            apply((ed) => addUserCut(ed, words));
            select(null);
          } else if (sel?.kind === "cut") {
            const cut = live.current.edit?.cuts.find((c) => c.id === sel.id);
            if (cut?.by === "user") {
              e.preventDefault();
              apply((ed) => deleteCut(ed, sel.id));
              select(null);
            }
          }
          return;
        }
        case "Escape":
          if (sp) closeSource();
          else select(null);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, undo, redo, select, transport, closeSource]);

  const dragSplit = (e: ReactPointerEvent) => {
    const col = leftCol.current;
    if (!col) return;
    const rect = col.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSplit(Math.min(0.8, Math.max(0.15, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div className="grid h-full grid-cols-[minmax(330px,27%)_minmax(0,1fr)_minmax(300px,23%)] grid-rows-[minmax(0,1fr)_auto]">
      <div ref={leftCol} className="col-start-1 row-start-1 flex min-h-0 flex-col border-r border-line bg-pane">
        <div className="min-h-0" style={{ flex: `${split} 1 0` }}>
          <ScriptPane />
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize script and transcript"
          aria-valuemin={15}
          aria-valuemax={80}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={0}
          onPointerDown={dragSplit}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              setSplit((v) => Math.min(0.8, Math.max(0.15, v + (e.key === "ArrowUp" ? -0.05 : 0.05))));
            }
          }}
          className="h-[5px] flex-none cursor-row-resize border-y border-line bg-ground hover:bg-line-strong"
        />
        <div className="min-h-0" style={{ flex: `${1 - split} 1 0` }}>
          <TranscriptPane />
        </div>
      </div>
      <div className="col-start-2 row-start-1 min-h-0 min-w-0 bg-ground">
        <Player />
      </div>
      <aside aria-label="Inspector" className="col-start-3 row-start-1 min-h-0 border-l border-line bg-pane">
        <Inspector />
      </aside>
      <div className="col-span-3 row-start-2 border-t border-line bg-pane">
        <Timeline />
      </div>
    </div>
  );
}
