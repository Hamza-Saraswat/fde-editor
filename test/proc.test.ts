import { describe, expect, it } from "vitest";
import { ProcError, run } from "../src/core/proc.ts";

describe("run", () => {
  it("keeps a failing command's stdout (hyperframes check prints its report there, then exits 1)", async () => {
    const err = await run("sh", ["-c", "echo 'Layout: sweep_static'; echo probe >&2; exit 1"]).catch((e) => e);
    expect(err).toBeInstanceOf(ProcError);
    expect((err as ProcError).stdout).toContain("sweep_static");
    expect((err as ProcError).stderr).toContain("probe");
  });
});
