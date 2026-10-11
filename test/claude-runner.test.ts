// Every test here runs a fake `claude`: a tiny node script that prints canned stream-json.
import { chmod, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildClaudeArgs, extractJson, runClaude, type ClaudeEvent } from "../src/claude/runner.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fde-claude-"));
});

/** Writes an executable fake claude that records its argv and prints `lines`. */
async function fakeClaude(name: string, lines: object[], opts: { exitCode?: number; hangMs?: number } = {}): Promise<string> {
  const file = join(dir, `${name}.cjs`);
  await writeFile(file, `#!${process.execPath}
require("fs").writeFileSync(__filename + ".args.json", JSON.stringify(process.argv.slice(2)));
for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + "\\n");
process.exitCode = ${opts.exitCode ?? 0};
${opts.hangMs ? `setTimeout(() => {}, ${opts.hangMs});` : ""}
`);
  await chmod(file, 0o755);
  return file;
}
const argsOf = async (bin: string): Promise<string[]> => JSON.parse(await readFile(`${bin}.args.json`, "utf8"));

const init = { type: "system", subtype: "init", model: "claude-opus", session_id: "sess-1", tools: ["Read"] };
const hook = { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart:startup" };
const assistant = (...content: object[]) => ({ type: "assistant", message: { role: "assistant", content }, session_id: "sess-1" });
const result = (over: object) => ({
  type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.42, duration_ms: 1234,
  permission_denials: [], terminal_reason: "completed", result: "", session_id: "sess-1", ...over,
});
const base = { model: "opus", maxTurns: 7, allowedTools: ["Read"] };

describe("runClaude", () => {
  it("returns structured_output and streams text and tool events", async () => {
    const bin = await fakeClaude("structured", [
      hook, init,
      assistant({ type: "text", text: "Reading the input." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/plan-input.json", offset: 0, limit: 2000 } }),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…" }] } },
      result({ result: "Plan ready.", structured_output: { takes: [], ok: true } }),
    ]);
    const events: ClaudeEvent[] = [];
    const logFile = join(dir, "logs", "structured.jsonl");
    const res = await runClaude({
      ...base, prompt: "Plan it", cwd: dir, bin, logFile, onEvent: (e) => events.push(e),
      jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      appendSystemPromptFile: "/prompts/edit-plan.md", addDirs: ["/a", "/b"],
    });
    expect(res).toMatchObject({ structured: { takes: [], ok: true }, text: "Plan ready.", costUsd: 0.42, turns: 3, sessionId: "sess-1", permissionDenials: [] });
    expect(events.map((e) => e.kind)).toEqual(["init", "text", "tool", "result"]);
    expect(events[2]).toEqual({ kind: "tool", name: "Read", input: "/p/plan-input.json [0+2000]" });
    expect(events[3]).toMatchObject({ kind: "result", ok: true, costUsd: 0.42 });

    const args = await argsOf(bin);
    expect(args.slice(0, 2)).toEqual(["-p", "Plan it"]);
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--output-format", "stream-json", "--verbose", "--max-turns", "7"]));
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual({ type: "object" });
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/prompts/edit-plan.md");
    expect(args.filter((a, i) => args[i - 1] === "--add-dir")).toEqual(["/a", "/b"]);
    expect(args.some((a) => /dangerously|bypassPermissions/.test(a))).toBe(false);

    const log = await readFile(logFile, "utf8");
    expect(log).toContain('"subtype":"init"');
    expect(log).toContain('"type":"result"');
  });

  it("falls back to JSON in the result text", async () => {
    const bin = await fakeClaude("text-json", [init, result({ result: "Here you go:\n```json\n{\"b\": 2}\n```\nDone." })]);
    const res = await runClaude({ ...base, prompt: "x", cwd: dir, bin });
    expect(res.structured).toEqual({ b: 2 });
    const bare = await fakeClaude("text-bare", [init, result({ result: "The plan is {\"c\": [1, 2]} as requested." })]);
    expect((await runClaude({ ...base, prompt: "x", cwd: dir, bin: bare })).structured).toEqual({ c: [1, 2] });
    const none = await fakeClaude("text-none", [init, result({ result: "No JSON here." })]);
    expect((await runClaude({ ...base, prompt: "x", cwd: dir, bin: none })).structured).toBeNull();
  });

  it("turns an auth failure into a `claude auth login` hint", async () => {
    // Shape copied from spikes/out/claude/stream.jsonl: subtype "success" but is_error true.
    const bin = await fakeClaude("auth", [
      hook, init,
      { ...assistant({ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }), error: "authentication_failed", is_api_error_message: true },
      result({ is_error: true, num_turns: 1, total_cost_usd: 0, terminal_reason: "api_error", result: "Failed to authenticate: OAuth session expired and could not be refreshed" }),
    ], { exitCode: 1 });
    await expect(runClaude({ ...base, prompt: "x", cwd: dir, bin })).rejects.toThrow(/claude auth login/);
  });

  it("reports other failures with their subtype", async () => {
    const bin = await fakeClaude("max-turns", [init, { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7, total_cost_usd: 1 }], { exitCode: 1 });
    await expect(runClaude({ ...base, prompt: "x", cwd: dir, bin })).rejects.toThrow(/turn limit/);
    const crash = await fakeClaude("crash", [init], { exitCode: 2 });
    await expect(runClaude({ ...base, prompt: "x", cwd: dir, bin: crash })).rejects.toThrow(/without a result/);
    await expect(runClaude({ ...base, prompt: "x", cwd: dir, bin: join(dir, "does-not-exist") })).rejects.toThrow(/Could not start/);
  });

  it("stops the process when the signal aborts", async () => {
    const bin = await fakeClaude("hang", [init], { hangMs: 60_000 });
    const ac = new AbortController();
    const started = Date.now();
    const run = runClaude({ ...base, prompt: "x", cwd: dir, bin, signal: ac.signal, onEvent: (e) => e.kind === "init" && ac.abort() });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pre = new AbortController();
    pre.abort();
    await expect(runClaude({ ...base, prompt: "x", cwd: dir, bin, signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses permission-bypass flags", () => {
    expect(() => buildClaudeArgs({ ...base, prompt: "x", cwd: dir, extraArgs: ["--dangerously-skip-permissions"] })).toThrow(/refusing/);
    expect(() => buildClaudeArgs({ ...base, prompt: "x", cwd: dir, extraArgs: ["--permission-mode", "bypassPermissions"] })).toThrow(/refusing/);
  });
});

describe("extractJson", () => {
  it("prefers the last fenced block that parses", () => {
    expect(extractJson("```json\n{\"a\":1}\n```\nthen\n```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(extractJson("```\n{\"a\":3}\n```")).toEqual({ a: 3 });
    expect(extractJson("")).toBeNull();
    expect(extractJson("{not json}")).toBeNull();
  });
});

describe("planEdit with a fake claude", () => {
  it("writes plan-input.json, plan.json and edit.json, retrying once on a schema failure", async () => {
    const projects = join(dir, "projects");
    process.env.FDE_PROJECTS_DIR = projects;
    const { planEdit } = await import("../src/claude/edit-plan.ts");
    const root = join(projects, "demo");
    await mkdir(root, { recursive: true });
    const clip = { id: "c1", name: "take1", path: "/x/take1.mov", duration: 5, width: 2560, height: 1440, fps: 30, codec: "h264", pixFmt: "yuv420p", hasAudio: true, vfr: false, hdr: false };
    const words = [["Hello", 1.0, 1.3], ["um", 1.4, 1.6], ["world.", 1.7, 2.1]].map(([text, start, end], i) => ({ id: `w${i}`, clipId: "c1", text, start, end }));
    const files: Record<string, object> = {
      "project.json": { slug: "demo", title: "Demo", createdAt: "2026-10-11T00:00:00Z", scriptSource: "/x/demo.md", clips: [clip] },
      "script.json": {
        title: "Demo",
        sections: [{ id: "sec0", title: "Intro", level: 2, sentenceIds: ["s0.1"] }],
        sentences: [{ id: "s0.1", sectionId: "sec0", blockId: "b0.1", text: "Hello world.", tokens: ["hello", "world"] }],
        cues: [{ id: "g1", kind: "gfx", optional: false, text: "globe", flags: [], sectionId: "sec0", afterSentenceId: null, holdSection: true }],
      },
      "transcript.json": { engine: "test", model: "test", words, silences: [], fillers: [{ id: "f0", clipId: "c1", start: 1.4, end: 1.6, kind: "token", wordId: "w1" }] },
      "candidates.json": { sentences: [{ sentenceId: "s0.1", chosen: 0, occurrences: [{ clipId: "c1", startWordId: "w0", endWordId: "w2", score: 0.9 }] }], adlibs: [], missing: [] },
    };
    for (const [f, v] of Object.entries(files)) await writeFile(join(root, f), JSON.stringify(v));

    const goodPlan = {
      takes: [{ sentenceIds: ["s0.1"], chosen: { startWordId: "w0", endWordId: "w2" }, alternates: [], why: "only take" }],
      adlibs: [], wordCuts: [], fillerGaps: [],
      cues: [{ cueId: "g1", include: true, anchorWordId: "w0", endWordId: "w2", layout: "side", brief: "a globe spins in" }],
      notes: "fine",
    };
    // First call returns a plan missing `notes`; the second (whose prompt carries the zod error) is valid.
    const bin = join(dir, "planner.cjs");
    await writeFile(bin, `#!${process.execPath}
const fs = require("fs");
const n = __filename + ".count";
const count = (fs.existsSync(n) ? Number(fs.readFileSync(n, "utf8")) : 0) + 1;
fs.writeFileSync(n, String(count));
fs.writeFileSync(__filename + ".prompt" + count, process.argv[3]);
const plan = ${JSON.stringify(goodPlan)};
if (count === 1) delete plan.notes;
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.5, permission_denials: [], result: "", structured_output: plan }) + "\\n");
`);
    await chmod(bin, 0o755);

    const res = await planEdit("demo", { bin });
    expect(res.costUsd).toBe(1);
    expect(await readFile(`${bin}.prompt2`, "utf8")).toMatch(/rejected by the validator[\s\S]*notes/);
    expect(await readFile(`${bin}.prompt1`, "utf8")).toContain(join(root, "runs", "plan-input.json"));
    expect(existsSync(join(root, "plan.json"))).toBe(true);
    const edit = JSON.parse(await readFile(join(root, "edit.json"), "utf8"));
    expect(edit.version).toBe(1);
    expect(edit.overlays[0]).toMatchObject({ id: "o-g1", anchorWordId: "w0" });
    expect(edit.cuts.some((c: { reason: string; start: number }) => c.reason === "filler" && c.start === 1.4)).toBe(true);
    const input = JSON.parse(await readFile(join(root, "runs", "plan-input.json"), "utf8"));
    expect(input.transcript).toEqual(["c1 1.00-2.10: w0:Hello w1:um w2:world."]);
    expect(input.fillers).toEqual(['f0 token c1 1.40-1.60 word=w1 "um"']);
    expect(input.takes).toEqual(["s0.1 aligner=0 | #0 c1 w0-w2 score=0.90"]);
  });
});
