// Phase 0 spike (b), live: the runner's exact headless path — JSON schema, stream-json, allow-list.
import { runClaude } from "../src/claude/runner.ts";
import { REPO_ROOT } from "../src/core/paths.ts";
const t0 = Date.now();
const res = await runClaude({
  prompt: "Step 1: try to run the shell command 'echo hello' with the Bash tool. Step 2: read the first line of package.json with the Read tool. Then answer: bash_worked = whether step 1 succeeded, file_first_line = the exact first line, n = 7*6.",
  jsonSchema: { type: "object", additionalProperties: false, properties: { bash_worked: { type: "boolean" }, file_first_line: { type: "string" }, n: { type: "integer" } }, required: ["bash_worked", "file_first_line", "n"] },
  allowedTools: ["Read"],
  model: "haiku",
  maxTurns: 6,
  cwd: REPO_ROOT,
  logFile: `${REPO_ROOT}/spikes/out/claude/live.jsonl`,
  onEvent: (e) => { if (e.kind === "tool") console.log("tool:", e.name, e.input); },
});
console.log(JSON.stringify({ structured: res.structured, permissionDenials: res.permissionDenials.length, turns: res.turns, costUsd: res.costUsd, seconds: (Date.now() - t0) / 1000 }, null, 2));
