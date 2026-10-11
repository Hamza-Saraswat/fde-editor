import { defineConfig } from "vitest/config";

// Slow end-to-end tests: real ffmpeg renders on the committed fixture recording.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
