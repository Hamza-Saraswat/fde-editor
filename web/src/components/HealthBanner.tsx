// Server health: Claude CLI login (blocking for plan/graphics/X clips) and the brand pack (quiet).
import { useState } from "react";
import { useApp } from "../state/app.tsx";
import { Icon } from "./Icon.tsx";

const LOGIN_CMD = "claude auth login";

export function HealthBanner({ compact = false }: { compact?: boolean }) {
  const { health, healthError, refreshHealth } = useApp();
  const [copied, setCopied] = useState(false);

  if (healthError) {
    return (
      <div role="alert" className="flex items-center gap-3 border-b border-line bg-[#2b2120] px-4 py-2 text-[12.5px]">
        <span className="dot" data-state="error" />
        <span className="text-ink">{healthError}</span>
        <button type="button" className="btn btn-sm ml-auto" onClick={refreshHealth}>
          Check again
        </button>
      </div>
    );
  }
  if (!health) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(LOGIN_CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the command is visible anyway */
    }
  };

  return (
    <>
      {!health.claudeLoggedIn && (
        <div role="alert" className="flex items-center gap-3 border-b border-line bg-[#2d2419] px-4 py-2 text-[12.5px]">
          <Icon name="warn" className="text-warn" />
          <span>
            Claude CLI isn't logged in. Run <code className="tc rounded bg-sunken px-1.5 py-0.5 text-ink">{LOGIN_CMD}</code> in a terminal
            {compact ? "." : ", then check again. Plan edit, Graphics and X clips need it."}
          </span>
          <button type="button" className="btn btn-sm" onClick={copy} aria-label="Copy the login command">
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={refreshHealth}>
            Check again
          </button>
        </div>
      )}
      {!health.brandReady && !compact && (
        <p className="px-4 py-1.5 text-[12px] text-muted" role="note">
          Brand pack isn't ready: brand/tokens.css or the intro and outro renders are missing.
        </p>
      )}
    </>
  );
}
