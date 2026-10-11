// Child processes (ffmpeg, ffprobe, hyperframes, claude). Every call can be logged to the
// project's runs/ folder and cancelled through an AbortSignal.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execa, type Options } from "execa";

export type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  log?: string; // file to append the command and its stderr to
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
  timeoutMs?: number;
};

export class ProcError extends Error {
  constructor(public cmd: string, public exitCode: number | undefined, public stderr: string) {
    super(`${cmd} failed (exit ${exitCode ?? "?"}): ${stderr.split("\n").filter(Boolean).slice(-6).join("\n")}`);
  }
}

export async function run(bin: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const cmd = [bin, ...args.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a))].join(" ");
  if (opts.log) {
    await mkdir(dirname(opts.log), { recursive: true });
    await appendFile(opts.log, `\n$ ${cmd}\n`);
  }
  const execOpts: Options = {
    cwd: opts.cwd,
    env: { HYPERFRAMES_NO_TELEMETRY: "1", ...opts.env },
    cancelSignal: opts.signal,
    reject: false,
    timeout: opts.timeoutMs,
    lines: false,
    stripFinalNewline: true,
  };
  const child = execa(bin, args, execOpts);
  const watch = (stream: NodeJS.ReadableStream | null | undefined, cb?: (l: string) => void) => {
    if (!stream || !cb) return;
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop() ?? "";
      for (const p of parts) if (p) cb(p);
    });
  };
  watch(child.stderr, opts.onStderrLine);
  watch(child.stdout, opts.onStdoutLine);
  const res = await child;
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  if (opts.log) await appendFile(opts.log, stderr.slice(-20000) + `\n[exit ${res.exitCode}]\n`);
  if (res.isCanceled) throw new ProcError(cmd, res.exitCode, "cancelled");
  if (res.failed) throw new ProcError(cmd, res.exitCode, stderr || String(res.message ?? ""));
  return { stdout, stderr };
}

export const ffmpeg = (args: string[], opts?: RunOptions & { logLevel?: string }) =>
  run("ffmpeg", ["-hide_banner", "-v", opts?.logLevel ?? "error", "-y", ...args], opts);
export const ffprobeJson = async (file: string, opts?: RunOptions) =>
  JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], opts)).stdout);
