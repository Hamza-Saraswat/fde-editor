// Engine choice for the Transcribe step: Parakeet (default), Whisper + model, or OpenAI whisper-1.
import { useEffect, useRef, useState } from "react";
import type { StageOptions } from "../types.ts";
import { useApp } from "../state/app.tsx";
import { Icon } from "./Icon.tsx";

export type TranscribeChoice = NonNullable<StageOptions["transcribe"]>;
type Engine = "parakeet" | "whisper" | "openai";
const MODELS = ["tiny.en", "base.en", "small.en", "medium.en", "large-v3"];

export const engineLabel = (c: TranscribeChoice) =>
  c.engine === "openai" ? "OpenAI whisper-1" : c.localEngine === "whisper" ? `Whisper ${c.localModel ?? ""}`.trim() : "Parakeet";

export function useTranscribeChoice(): [TranscribeChoice, (c: TranscribeChoice) => void] {
  const { config } = useApp();
  const [choice, setChoice] = useState<TranscribeChoice | null>(null);
  const fallback: TranscribeChoice = {
    engine: config?.transcription.engine ?? "local",
    localEngine: config?.transcription.localEngine ?? "parakeet",
    localModel: config?.transcription.localModel ?? "medium.en",
  };
  return [choice ?? fallback, setChoice];
}

export function TranscribeOptions({ value, onChange }: { value: TranscribeChoice; onChange: (c: TranscribeChoice) => void }) {
  const { health } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openaiOk = !!health?.openaiKey;
  const engine: Engine = value.engine === "openai" ? "openai" : value.localEngine === "whisper" ? "whisper" : "parakeet";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (e: Engine) => {
    if (e === "openai") onChange({ ...value, engine: "openai" });
    else onChange({ ...value, engine: "local", localEngine: e });
  };

  const row = (e: Engine, title: string, hint: string, disabled = false) => (
    <label className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 ${disabled ? "opacity-50" : "hover:bg-hover"}`}>
      <input type="radio" name="transcribe-engine" className="mt-0.5 accent-[var(--color-accent)]" checked={engine === e} disabled={disabled} onChange={() => pick(e)} />
      <span>
        <span className="block text-ink">{title}</span>
        <span className="meta block">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="-ml-1 inline-flex h-[18px] items-center gap-1 rounded px-1 text-muted hover:bg-raised hover:text-ink"
        aria-label={`Transcription engine: ${engineLabel(value)}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Transcription engine"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="max-w-[120px] truncate text-[11px]">{engineLabel(value)}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div role="dialog" aria-label="Transcription engine" className="absolute left-0 top-8 z-40 w-[290px] rounded-lg border border-line-strong bg-raised p-2 shadow-2xl">
          <fieldset className="grid gap-0.5">
            <legend className="sr-only">Engine</legend>
            {row("parakeet", "Local Parakeet (default)", "On this Mac. No key, no cost.")}
            {row("whisper", "Local Whisper", "On this Mac. Pick a model below.")}
            {engine === "whisper" && (
              <label className="ml-8 flex items-center gap-2 pb-1">
                <span className="meta">Model</span>
                <select className="field h-7" value={value.localModel ?? "medium.en"} onChange={(e) => onChange({ ...value, localModel: e.target.value })}>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {row("openai", "OpenAI whisper-1", openaiOk ? "Sends the audio to OpenAI. Billed per minute." : "Add OPENAI_API_KEY to .env and restart the server to use this.", !openaiOk)}
          </fieldset>
          <label className="mt-1 flex items-center gap-2 border-t border-line px-2 pt-2 text-[12px] text-ink-2">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={!!value.force} onChange={(e) => onChange({ ...value, force: e.target.checked })} />
            Transcribe again even if this engine already ran
          </label>
        </div>
      )}
    </div>
  );
}
