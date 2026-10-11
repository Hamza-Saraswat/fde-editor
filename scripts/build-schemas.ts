// Writes the JSON schemas Claude's structured-output runs are held to, generated from the zod
// schemas so the two never drift. Run with `pnpm schemas`.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SCHEMAS_DIR } from "../src/core/paths.ts";
import { EditPlanSchema, XClipPlanSchema } from "../src/core/schema.ts";

const outputs: [string, z.ZodType][] = [
  ["edit-plan.json", EditPlanSchema],
  ["x-clips.json", XClipPlanSchema],
];

await mkdir(SCHEMAS_DIR, { recursive: true });
for (const [file, schema] of outputs) {
  const path = join(SCHEMAS_DIR, file);
  await writeFile(path, JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n");
  console.log(`wrote ${path}`);
}
