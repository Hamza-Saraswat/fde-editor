// The edit's audio, assembled sample by sample from the clips' 48 kHz WAVs. Every join is an
// equal-power crossfade centred on the cut: each piece carries a short handle of source audio past
// both of its ends, so the total stays exactly frames × 48000 / fps samples (A/V stays in sync) and the
// level never dips at a cut. A fade-out/fade-in pair at every cut (the previous approach) left a 60 ms
// hole in the sound, which made tight joins in flowing speech sound chopped.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { projectPaths } from "../core/paths.ts";
import type { Clip, Timeline } from "../core/schema.ts";
import { loadConfig, loadProject } from "../core/store.ts";
import { SAMPLE_RATE, atomicOutput, prepareClip, type MediaOptions } from "./prepare.ts";
import { readWavLayout, sampleRange } from "./segments.ts";

const CH = 2; // stereo, s16le

/** One segment's sample range in its clip, plus the handles it shares with its neighbours. */
/** a0/a1: the exact kept audio (clip samples) when the frame grid widened the piece past it. */
export type Piece = { clipId: string; s0: number; s1: number; lead: number; trail: number; a0?: number; a1?: number; fadeIn?: number; fadeOut?: number };

const EDGE_RAMP = 0.004; // seconds of ramp where the mix silences a widened sliver (no click)

/** Pure: pieces for a timeline. Each handle is half the crossfade, at most half of either piece. */
export function planPieces(timeline: Timeline, crossfadeMs: number): Piece[] {
  const half = Math.round(((crossfadeMs / 1000) * SAMPLE_RATE) / 2);
  const pieces = timeline.segments.map((s) => {
    const [s0, s1] = sampleRange(s, timeline.fps);
    const p: Piece = { clipId: s.clipId, s0, s1, lead: 0, trail: 0 };
    if (s.audioIn !== undefined) p.a0 = Math.round(s.audioIn * SAMPLE_RATE);
    if (s.audioOut !== undefined) p.a1 = Math.round(s.audioOut * SAMPLE_RATE);
    if (s.fadeInMs) p.fadeIn = Math.round((s.fadeInMs / 1000) * SAMPLE_RATE);
    if (s.fadeOutMs) p.fadeOut = Math.round((s.fadeOutMs / 1000) * SAMPLE_RATE);
    return p;
  });
  for (let i = 1; i < pieces.length; i++) {
    const a = pieces[i - 1]!, b = pieces[i]!;
    const h = Math.max(0, Math.min(half, Math.floor((a.s1 - a.s0) / 2), Math.floor((b.s1 - b.s0) / 2)));
    a.trail = h;
    b.lead = h;
  }
  return pieces;
}

/**
 * Pure: shape one piece and lay it over the previous piece's tail. `data` is the piece's source from
 * s0 − lead to s1 + trail (interleaved stereo). Returns the finished samples and the faded tail that
 * the next piece crossfades with. The first and last pieces get a short plain fade at the outer edge.
 */
export function mixPiece(piece: Piece, data: Int16Array, carry: Float32Array, edge: { first: boolean; last: boolean; fade: number }): { out: Int16Array; carry: Float32Array } {
  const frames = piece.s1 - piece.s0 + piece.lead + piece.trail;
  if (data.length !== frames * CH) throw new Error(`piece data has ${data.length / CH} frames, expected ${frames}`);
  if (carry.length !== 2 * piece.lead * CH) throw new Error("crossfade handles of neighbouring pieces differ");
  const f = Float32Array.from(data);
  const gain = (from: number, len: number, g: (k: number) => number) => {
    for (let k = 0; k < len; k++) for (let c = 0; c < CH; c++) f[(from + k) * CH + c]! *= g(k);
  };
  // silence what the frame grid added past the exact cut (cut material), with a tiny ramp
  if (piece.a0 !== undefined || piece.a1 !== undefined) {
    const ramp = Math.max(1, Math.round(EDGE_RAMP * SAMPLE_RATE));
    const first = piece.s0 - piece.lead; // clip sample at data index 0
    const a0 = (piece.a0 ?? -Infinity) - first, a1 = (piece.a1 ?? Infinity) - first;
    gain(0, frames, (k) => Math.max(0, Math.min(1, (k - a0) / ramp + 1, (a1 - k) / ramp + 1)));
  }
  // a soft fade where the edge sits inside continuous speech (ends on the vowel, not the next consonant)
  if (piece.fadeIn || piece.fadeOut) {
    const first = piece.s0 - piece.lead;
    const inAt = (piece.a0 ?? piece.s0) - first, outAt = (piece.a1 ?? piece.s1) - first;
    const fi = piece.fadeIn ?? 0, fo = piece.fadeOut ?? 0;
    gain(0, frames, (k) => (fi && k < inAt + fi ? Math.sin((Math.PI / 2) * Math.max(0, Math.min(1, (k - inAt) / fi))) : 1)
      * (fo && k > outAt - fo ? Math.cos((Math.PI / 2) * Math.max(0, Math.min(1, (k - (outAt - fo)) / fo))) : 1));
  }
  const fadeIn = piece.lead > 0 ? 2 * piece.lead : edge.first ? Math.min(edge.fade, frames) : 0;
  gain(0, fadeIn, (k) => Math.sin((Math.PI / 2) * ((k + 0.5) / fadeIn)));
  const fadeOut = piece.trail > 0 ? 2 * piece.trail : edge.last ? Math.min(edge.fade, frames) : 0;
  gain(frames - fadeOut, fadeOut, (k) => Math.cos((Math.PI / 2) * ((k + 0.5) / fadeOut)));
  for (let k = 0; k < carry.length; k++) f[k]! += carry[k]!;
  const keep = (frames - 2 * piece.trail) * CH;
  const out = new Int16Array(keep);
  for (let k = 0; k < keep; k++) out[k] = Math.max(-32768, Math.min(32767, Math.round(f[k]!)));
  return { out, carry: f.slice(keep) };
}

/** Pure: the whole mix in memory (tests and short timelines). */
export function crossfadePieces(pieces: Piece[], datas: Int16Array[], fade: number): Int16Array {
  const parts: Int16Array[] = [];
  let carry: Float32Array = new Float32Array(0);
  pieces.forEach((p, i) => {
    const r = mixPiece(p, datas[i]!, carry, { first: i === 0, last: i === pieces.length - 1, fade });
    parts.push(r.out);
    carry = r.carry;
  });
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

/** 44-byte header of a PCM s16le 48 kHz stereo WAV with `frames` sample frames. */
export function wavHeader(frames: number): Buffer {
  const bytes = frames * CH * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + bytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(CH, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * CH * 2, 28);
  h.writeUInt16LE(CH * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(bytes, 40);
  return h;
}

export type MixdownOptions = MediaOptions & { clips?: Clip[] };

/** Write the timeline's audio to `out` (PCM s16le 48 kHz stereo), crossfaded at every cut. */
export async function mixdown(slug: string, timeline: Timeline, out: string, opts: MixdownOptions = {}): Promise<{ frames: number }> {
  const config = opts.config ?? (await loadConfig());
  const clips = opts.clips ?? (await loadProject(slug)).clips;
  const pieces = planPieces(timeline, config.edit.fadeMs);
  const fade = Math.round((config.edit.fadeMs / 2 / 1000) * SAMPLE_RATE);

  // each clip's 48 kHz wav (the render audio source), opened once
  const sources = new Map<string, { fd: number; dataOffset: number; frames: number } | null>();
  try {
    for (const clipId of new Set(pieces.map((p) => p.clipId))) {
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) throw new Error(`Timeline references unknown clip ${clipId}`);
      if (!clip.hasAudio) { sources.set(clipId, null); continue; }
      const { wav } = await prepareClip(slug, clip, { only: ["wav"], config, signal: opts.signal, log: opts.log });
      const layout = await readWavLayout(wav);
      if (!layout || layout.format !== 1 || layout.bits !== 16 || layout.channels !== CH || layout.sampleRate !== SAMPLE_RATE) {
        throw new Error(`${clip.name}: render audio must be 48 kHz 16-bit stereo PCM (${projectPaths(slug).wav(clip.id)})`);
      }
      const fd = openSync(wav, "r");
      sources.set(clipId, { fd, dataOffset: layout.dataOffset, frames: Math.floor((fstatSync(fd).size - layout.dataOffset) / (CH * 2)) });
    }

    // source from s0 − lead to s1 + trail; silence outside the clip or for a clip with no audio
    const read = (p: Piece): Int16Array => {
      const from = p.s0 - p.lead, to = p.s1 + p.trail;
      const buf = Buffer.alloc((to - from) * CH * 2);
      const src = sources.get(p.clipId);
      if (src) {
        const a = Math.max(0, from), b = Math.min(src.frames, to);
        if (b > a) readSync(src.fd, buf, (a - from) * CH * 2, (b - a) * CH * 2, src.dataOffset + a * CH * 2);
      }
      return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    };

    const total = pieces.reduce((n, p) => n + p.s1 - p.s0, 0);
    await atomicOutput(out, async (part) => {
      const fh = await open(part, "w");
      try {
        await fh.write(wavHeader(total));
        let carry: Float32Array = new Float32Array(0);
        for (let i = 0; i < pieces.length; i++) {
          if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("cancelled");
          const r = mixPiece(pieces[i]!, read(pieces[i]!), carry, { first: i === 0, last: i === pieces.length - 1, fade });
          carry = r.carry;
          await fh.write(Buffer.from(r.out.buffer, r.out.byteOffset, r.out.byteLength));
        }
      } finally {
        await fh.close();
      }
    });
    return { frames: total };
  } finally {
    for (const s of sources.values()) if (s) closeSync(s.fd);
  }
}
