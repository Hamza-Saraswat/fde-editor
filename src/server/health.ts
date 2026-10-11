// GET /api/health: is everything the pipeline needs in place?
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { REPO_ROOT, brandPaths } from "../core/paths.ts";
import { cleanClaudeEnv } from "../claude/runner.ts";
import type { Health } from "./api.ts";

/** `claude auth status --json` in a clean env (no host-session variables), 5 s timeout. */
export async function claudeAuthStatus(bin = "claude"): Promise<boolean> {
  try {
    const res = await execa(bin, ["auth", "status", "--json"], {
      env: cleanClaudeEnv(),
      extendEnv: false,
      timeout: 5000,
      reject: false,
      stdin: "ignore",
    });
    const parsed = JSON.parse(String(res.stdout ?? "")) as { loggedIn?: unknown };
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

/** Wraps a status check so it runs at most once per `ttlMs` (concurrent callers share one run). */
export function cached(check: () => Promise<boolean>, ttlMs = 30_000): () => Promise<boolean> {
  let value: { at: number; result: Promise<boolean> } | null = null;
  return () => {
    if (!value || Date.now() - value.at > ttlMs) value = { at: Date.now(), result: check().catch(() => false) };
    return value.result;
  };
}

export function hyperframesVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "hyperframes", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "missing";
  }
}

export const brandReady = () => existsSync(brandPaths.tokens) && existsSync(brandPaths.intro) && existsSync(brandPaths.outro);

export async function health(claudeLoggedIn: () => Promise<boolean>): Promise<Health> {
  return {
    ok: true,
    claudeLoggedIn: await claudeLoggedIn(),
    openaiKey: Boolean(process.env.OPENAI_API_KEY),
    hyperframesVersion: hyperframesVersion(),
    brandReady: brandReady(),
  };
}
