import { describe, expect, it } from "vitest";
import { trimWordsToSpeech } from "../src/transcribe/speech.ts";

const w = (id: string, text: string, start: number, end: number) => ({ id, clipId: "c1", text, start, end });
const sil = (start: number, end: number) => ({ clipId: "c1", start, end });

describe("trimWordsToSpeech", () => {
  it("cuts a word stamp off where a long silence starts (real case: 'team.' stamped 21.6–39.2 s)", () => {
    const out = trimWordsToSpeech([w("w40", "team.", 21.6, 39.2), w("w41", "Okay", 39.2, 39.52)],
      [sil(21.72, 25.14), sil(25.16, 25.45), sil(25.46, 35.35), sil(35.37, 39.05)]);
    expect(out[0]).toMatchObject({ start: 21.6, end: 21.72 });
    expect(out[1]).toMatchObject({ start: 39.2, end: 39.52 });
  });
  it("moves a word's start past a leading silence", () => {
    const [a] = trimWordsToSpeech([w("w1", "pages,", 17.84, 19.04)], [sil(17.34, 18.07)]);
    expect(a).toMatchObject({ start: 18.07, end: 19.04 });
  });
  it("ignores short silences (stop consonants, tiny gaps)", () => {
    const [a] = trimWordsToSpeech([w("w1", "stop", 1.0, 1.4)], [sil(1.15, 1.3)]);
    expect(a).toMatchObject({ start: 1.0, end: 1.4 });
  });
  it("keeps the original stamp when nothing sensible would be left", () => {
    const [a] = trimWordsToSpeech([w("w1", "a", 2.0, 2.3)], [sil(1.9, 2.29)]);
    expect(a).toMatchObject({ start: 2.0, end: 2.3 });
  });
});
