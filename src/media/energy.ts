// Loudness envelope of a clip (RMS per 10 ms), read straight from its 16-bit PCM WAV. Used to put cut
// points in the quiet valleys between sounds instead of trusting ASR word stamps, which for
// Parakeet are quantized to ~80 ms and often leave the edge of an "uh" behind.
import { open } from "node:fs/promises";

export type Envelope = { hop: number; rms: Float32Array };

const HOP = 0.01;

/** Parse a PCM s16le WAV (any rate, any channels) into an RMS envelope with a 10 ms hop. */
export async function loadEnvelope(wavPath: string): Promise<Envelope> {
  const fh = await open(wavPath, "r");
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${wavPath} is not a WAV file`);
    let pos = 12, channels = 1, rate = 16000, bits = 16, dataStart = -1, dataLen = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const len = buf.readUInt32LE(pos + 4);
      if (id === "fmt ") {
        channels = buf.readUInt16LE(pos + 10);
        rate = buf.readUInt32LE(pos + 12);
        bits = buf.readUInt16LE(pos + 22);
      } else if (id === "data") {
        dataStart = pos + 8;
        dataLen = Math.min(len, buf.length - dataStart);
        break;
      }
      pos += 8 + len + (len % 2);
    }
    if (dataStart < 0 || bits !== 16) throw new Error(`${wavPath}: expected 16-bit PCM`);
    const frameBytes = 2 * channels;
    const frames = Math.floor(dataLen / frameBytes);
    const perHop = Math.max(1, Math.round(rate * HOP));
    const rms = new Float32Array(Math.ceil(frames / perHop));
    for (let h = 0; h < rms.length; h++) {
      let sum = 0;
      const from = h * perHop, to = Math.min(frames, from + perHop);
      for (let f = from; f < to; f++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += buf.readInt16LE(dataStart + f * frameBytes + c * 2);
        v /= channels * 32768;
        sum += v * v;
      }
      rms[h] = Math.sqrt(sum / Math.max(1, to - from));
    }
    return { hop: HOP, rms };
  } finally {
    await fh.close();
  }
}

/** Time of the quietest 10 ms in [from, to] (ties → closest to `prefer`). */
export function valley(env: Envelope, from: number, to: number, prefer = (from + to) / 2): number {
  const a = Math.max(0, Math.floor(from / env.hop)), b = Math.min(env.rms.length - 1, Math.ceil(to / env.hop));
  if (b < a) return prefer;
  let best = a, bestV = Infinity;
  for (let i = a; i <= b; i++) {
    const v = env.rms[i]!;
    const t = i * env.hop;
    if (v < bestV - 1e-6 || (Math.abs(v - bestV) <= 1e-6 && Math.abs(t - prefer) < Math.abs(best * env.hop - prefer))) {
      best = i;
      bestV = v;
    }
  }
  return best * env.hop + env.hop / 2;
}

/**
 * Widen/move a cut so both edges sit in the quietest point near the stamped edges, staying inside
 * [minStart, maxEnd] (the neighbouring words' safe zones).
 */
export function refineSpan(env: Envelope, start: number, end: number, minStart: number, maxEnd: number, reach = 0.16): { start: number; end: number } {
  const s = valley(env, Math.max(minStart, start - reach), Math.min(end, start + 0.04), start);
  const e = valley(env, Math.max(s + 0.02, end - 0.04), Math.min(maxEnd, end + reach), end);
  return e - s >= 0.05 ? { start: s, end: e } : { start, end };
}
