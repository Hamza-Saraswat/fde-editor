// Shared inspector chrome.
import type { ReactNode } from "react";
import { useProject } from "../state/ProjectProvider.tsx";
import { Icon } from "./Icon.tsx";

export function InspectorHeader({ title, children, onClose }: { title: ReactNode; children?: ReactNode; onClose?: () => void }) {
  const { select } = useProject();
  return (
    <header className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-pane px-3">
      <h2 className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-ink">{title}</h2>
      <span className="ml-auto flex items-center gap-2">{children}</span>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Close inspector (Esc)" onClick={onClose ?? (() => select(null))}>
        <Icon name="close" size={13} />
      </button>
    </header>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-[11.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="meta">{hint}</span>}
    </div>
  );
}
