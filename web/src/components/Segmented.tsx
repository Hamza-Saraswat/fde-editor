import type { ReactNode } from "react";

type Option<T extends string> = { value: T; label: ReactNode; title?: string; disabled?: boolean };

/** A radio group drawn as a segmented control. Arrow keys move the choice. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const move = (dir: number) => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`seg ${className}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          move(-1);
        }
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className="disabled:opacity-40"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
