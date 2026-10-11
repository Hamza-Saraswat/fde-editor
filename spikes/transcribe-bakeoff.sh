#!/usr/bin/env bash
# Phase 0 spike (a): compare local transcription engines on 3 minutes of a real take.
# Usage: spikes/transcribe-bakeoff.sh "<source video>" [start_seconds]
# Output: spikes/out/bakeoff/<engine>-<model>.json + timings.tsv
set -euo pipefail
SRC="$1"
START="${2:-60}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/spikes/out/bakeoff"
HF="$ROOT/node_modules/.bin/hyperframes"
export HYPERFRAMES_NO_TELEMETRY=1
mkdir -p "$OUT"

# 3-minute excerpt: 16 kHz mono WAV for local engines, 64 kbps mono mp3 for the API.
ffmpeg -v error -y -ss "$START" -t 180 -i "$SRC" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$OUT/excerpt.wav"
ffmpeg -v error -y -i "$OUT/excerpt.wav" -c:a libmp3lame -b:a 64k "$OUT/excerpt.mp3"

printf "engine\tmodel\tseconds\twords\n" > "$OUT/timings.tsv"

run() {
  local engine="$1" model="$2" dir="$OUT/run-$1-$2"
  rm -rf "$dir" && mkdir -p "$dir"
  local t0=$(date +%s)
  if [ "$engine" = parakeet ]; then
    "$HF" transcribe "$OUT/excerpt.wav" -d "$dir" --json --engine parakeet --language en > "$dir/stdout.json" 2> "$dir/stderr.log" || { echo "$engine $model FAILED"; return 0; }
  else
    "$HF" transcribe "$OUT/excerpt.wav" -d "$dir" --json --engine whisper --model "$model" --language en > "$dir/stdout.json" 2> "$dir/stderr.log" || { echo "$engine $model FAILED"; return 0; }
  fi
  local t1=$(date +%s)
  cp "$dir/transcript.json" "$OUT/$engine-$model.json" 2>/dev/null || true
  local n=$(node -e "try{console.log(require('$dir/transcript.json').length)}catch{console.log('?')}")
  printf "%s\t%s\t%s\t%s\n" "$engine" "$model" "$((t1 - t0))" "$n" >> "$OUT/timings.tsv"
  echo "$engine $model: $((t1 - t0))s, $n words"
}

run whisper small.en
run whisper medium.en
run whisper large-v3
if "$HF" models install parakeet --json > "$OUT/parakeet-install.json" 2>&1; then
  run parakeet default
else
  echo "parakeet install failed (see parakeet-install.json)"
fi

if [ -n "${OPENAI_API_KEY:-}" ]; then
  for mode in plain filler; do
    prompt=""
    [ "$mode" = filler ] && prompt="Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, so, um, yeah."
    t0=$(date +%s)
    curl -sS https://api.openai.com/v1/audio/transcriptions \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -F file=@"$OUT/excerpt.mp3" -F model=whisper-1 -F response_format=verbose_json \
      -F "timestamp_granularities[]=word" -F "timestamp_granularities[]=segment" \
      ${prompt:+-F "prompt=$prompt"} -o "$OUT/openai-raw-$mode.json"
    t1=$(date +%s)
    dir="$OUT/run-openai-$mode"; rm -rf "$dir"; mkdir -p "$dir"
    "$HF" transcribe "$OUT/openai-raw-$mode.json" -d "$dir" --json > "$dir/stdout.json" 2> "$dir/stderr.log" || true
    cp "$dir/transcript.json" "$OUT/openai-whisper-1-$mode.json" 2>/dev/null || true
    printf "openai\twhisper-1-%s\t%s\t?\n" "$mode" "$((t1 - t0))" >> "$OUT/timings.tsv"
    echo "openai $mode: $((t1 - t0))s"
  done
else
  echo "OPENAI_API_KEY not set: skipping API rows"
fi
echo DONE
