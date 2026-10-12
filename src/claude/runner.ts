// Runs headless Claude Code (`claude -p`) on the user's own login and streams its progress.
// Never bypasses permissions: tools must be pre-approved through allowedTools; anything else is
// denied (and reported in permissionDenials) because nobody is there to answer a prompt.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { execa } from "execa";

/** process.env minus anything a parent Claude Code session injected. */
export function cleanClaudeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_AGENT_SDK_") || k === "ANTHROPIC_BASE_URL" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    out[k] = v;
  }
  return out;
}

export type ClaudeEvent =
  | { kind: "init"; model: string; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: string } // input: one-line summary of the tool call
  | { kind: "result"; ok: boolean; text: string; costUsd?: number; turns?: number; durationMs?: number };

export type RunClaudeOptions = {
  prompt: string;
  appendSystemPromptFile?: string;
  jsonSchema?: object;
  allowedTools: string[];
  model: string;
  maxTurns: number;
  cwd: string;
  addDirs?: string[];
  signal?: AbortSignal;
  logFile?: string; // raw stream-json lines are appended here
  onEvent?: (e: ClaudeEvent) => void;
  bin?: string; // default "claude"
  extraArgs?: string[];
  env?: Record<string, string>; // added on top of the cleaned environment
};

export type RunClaudeResult = {
  structured: unknown | null;
  text: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  permissionDenials: unknown[];
};

export class ClaudeError extends Error {
  constructor(message: string, public subtype?: string, public resultText?: string) {
    super(message);
    this.name = "ClaudeError";
  }
}

const FORBIDDEN_ARGS = /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$|bypassPermissions/;

export function buildClaudeArgs(opts: RunClaudeOptions): string[] {
  const args = [
    "-p", opts.prompt, // positional prompt first: --allowedTools and --add-dir are variadic
    "--model", opts.model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(opts.maxTurns),
    "--strict-mcp-config", // no MCP servers: faster start, nothing to authenticate
  ];
  // Lock the run down. --allowedTools only PRE-APPROVES; on its own it does not stop other tools
  // (a live check ran Bash with only "Read" allowed). So: --tools makes only the needed tools exist,
  // dontAsk denies anything not pre-approved instead of prompting/auto-approving, and --restricted
  // ignores user/project settings and confines file tools to the cwd + --add-dir folders.
  const tools = [...new Set(opts.allowedTools.map((t) => t.replace(/\(.*$/, "")))];
  args.push("--tools", tools.join(","), "--permission-mode", "dontAsk", "--restricted");
  if (opts.allowedTools.length) args.push("--allowedTools", ...opts.allowedTools);
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(stripMetaSchema(opts.jsonSchema)));
  if (opts.appendSystemPromptFile) args.push("--append-system-prompt-file", opts.appendSystemPromptFile);
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  args.push(...(opts.extraArgs ?? []));
  const bad = args.slice(2).find((a) => FORBIDDEN_ARGS.test(a));
  if (bad) throw new Error(`refusing to run claude with ${bad}`);
  return args;
}

// The CLI validates --json-schema itself; a draft-2020-12 "$schema" URI only risks a meta-schema lookup.
function stripMetaSchema(schema: object): object {
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return rest;
}

export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  if (opts.signal?.aborted) throw abortError();
  const args = buildClaudeArgs(opts);
  const bin = opts.bin ?? "claude";

  let log: WriteStream | undefined;
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    log = createWriteStream(opts.logFile, { flags: "a" });
    log.write(`# ${new Date().toISOString()} ${bin} ${JSON.stringify(args.map((a) => (a.length > 400 ? `${a.slice(0, 400)}…` : a)))}\n`);
  }

  const child = execa(bin, args, {
    cwd: opts.cwd,
    // When this app is started from inside a Claude Code / desktop-app session, that session's
    // variables (CLAUDECODE, CLAUDE_CODE_*, ANTHROPIC_BASE_URL) leak into the child and point it at
    // the host's auth instead of the user's own `claude auth login`. Start it from a clean slate.
    env: { ...cleanClaudeEnv(), ...opts.env },
    extendEnv: false,
    cancelSignal: opts.signal,
    reject: false,
    stdin: "ignore",
    stripFinalNewline: false,
    forceKillAfterDelay: 3000,
  });

  let result: Record<string, unknown> | null = null;
  const texts: string[] = [];
  let buf = "";
  const onLine = (line: string) => {
    if (!line.trim()) return;
    log?.write(line + "\n");
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    for (const e of toEvents(ev)) {
      if (e.kind === "text") texts.push(e.text);
      opts.onEvent?.(e);
    }
    if (ev.type === "result") result = ev;
  };
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(onLine);
  });

  const res = await child;
  if (buf) onLine(buf);
  const stderr = String(res.stderr ?? "");
  if (log) {
    if (stderr.trim()) log.write(`# stderr\n${stderr.slice(-20000)}\n`);
    log.write(`# exit ${res.exitCode ?? res.signal ?? "?"}\n`);
    await new Promise<void>((r) => log!.end(r));
  }

  if (res.isCanceled || opts.signal?.aborted) throw abortError();
  const r = result as Record<string, unknown> | null;
  if (!r) {
    const tail = stderr.trim().split("\n").slice(-6).join("\n") || String(res.message ?? "");
    if (res.failed && /ENOENT/.test(String(res.message))) {
      throw new ClaudeError(`Could not start "${bin}". Install Claude Code and run \`claude auth login\` once.`);
    }
    throw new ClaudeError(`Claude exited (${res.exitCode ?? res.signal ?? "?"}) without a result${tail ? `: ${tail}` : ""}`);
  }

  const resultText = typeof r.result === "string" ? r.result : "";
  const subtype = typeof r.subtype === "string" ? r.subtype : undefined;
  if (r.is_error === true || subtype !== "success") {
    throw new ClaudeError(errorMessage(resultText, subtype, r), subtype, resultText);
  }

  const structured = r.structured_output !== undefined && r.structured_output !== null
    ? r.structured_output
    : extractJson(resultText) ?? extractJson(texts.at(-1) ?? "");
  return {
    structured,
    text: resultText,
    costUsd: num(r.total_cost_usd),
    turns: num(r.num_turns),
    sessionId: typeof r.session_id === "string" ? r.session_id : undefined,
    permissionDenials: Array.isArray(r.permission_denials) ? r.permission_denials : [],
  };
}

function errorMessage(text: string, subtype: string | undefined, r: Record<string, unknown>): string {
  if (/authenticat|oauth|log ?in|logged out|401|credential|invalid api key|api key/i.test(text)) {
    return `Claude Code is not signed in (${text.trim() || "authentication failed"}). Run \`claude auth login\` in a terminal, then try again.`;
  }
  if (subtype === "error_max_turns") return `Claude hit the turn limit (${num(r.num_turns) ?? "?"} turns) before finishing. Raise claude.maxTurns in fde-editor.config.json or retry.`;
  if (subtype === "error_max_structured_output_retries") return `Claude could not produce output that matches the JSON schema${text ? `: ${text}` : ""}`;
  const reason = [subtype, typeof r.terminal_reason === "string" ? r.terminal_reason : undefined].filter(Boolean).join(", ");
  return `Claude run failed${reason ? ` (${reason})` : ""}${text ? `: ${text}` : ""}`;
}

function toEvents(ev: Record<string, unknown>): ClaudeEvent[] {
  if (ev.type === "system" && ev.subtype === "init") {
    return [{ kind: "init", model: String(ev.model ?? ""), sessionId: String(ev.session_id ?? "") }];
  }
  if (ev.type === "assistant") {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: ClaudeEvent[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) out.push({ kind: "text", text: block.text });
      if (block.type === "tool_use") out.push({ kind: "tool", name: String(block.name ?? "tool"), input: summarizeInput(block.input) });
    }
    return out;
  }
  if (ev.type === "result") {
    return [{
      kind: "result",
      ok: ev.is_error !== true && ev.subtype === "success",
      text: typeof ev.result === "string" ? ev.result : "",
      costUsd: num(ev.total_cost_usd),
      turns: num(ev.num_turns),
      durationMs: num(ev.duration_ms),
    }];
  }
  return [];
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "query", "description"]) {
    if (typeof o[key] === "string") {
      const extra = key === "file_path" && (o.offset !== undefined || o.limit !== undefined) ? ` [${o.offset ?? 0}+${o.limit ?? ""}]` : "";
      return clip(String(o[key]) + extra);
    }
  }
  return clip(JSON.stringify(o));
}

const clip = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** Pull a JSON object out of free text: a fenced ```json block, the whole text, or the outermost {…}. */
export function extractJson(text: string): unknown | null {
  if (!text.trim()) return null;
  const tryParse = (s: string): unknown | null => {
    try {
      const v = JSON.parse(s);
      return v !== null && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const f of fences.reverse()) {
    const v = tryParse(f.trim());
    if (v) return v;
  }
  const whole = tryParse(text.trim());
  if (whole) return whole;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  return a >= 0 && b > a ? tryParse(text.slice(a, b + 1)) : null;
}

function abortError(): Error {
  const e = new Error("Claude run cancelled");
  e.name = "AbortError";
  return e;
}
