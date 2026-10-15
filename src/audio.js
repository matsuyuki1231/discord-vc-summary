// Discord から届く PCM（48kHz / ステレオ / s16le）を Whisper 向けに加工する処理

const INPUT_CHANNELS = 2;
const DECIMATION = 3; // 48kHz → 16kHz
export const OUTPUT_SAMPLE_RATE = 16000;

/**
 * 48kHz ステレオ PCM を 16kHz モノラル PCM に変換する。
 * 隣接 3 フレーム × 2ch の平均を取ることで、簡易的なローパスを兼ねる。
 * opusscript の decode 結果は WASM メモリを共有しているため、必ず新しい Buffer にコピーして返す。
 */
export function toMono16k(pcm) {
  const frameCount = Math.floor(pcm.length / (2 * INPUT_CHANNELS));
  const outCount = Math.floor(frameCount / DECIMATION);
  const out = Buffer.alloc(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    let sum = 0;
    for (let f = 0; f < DECIMATION; f++) {
      const base = ((i * DECIMATION + f) * INPUT_CHANNELS) * 2;
      sum += pcm.readInt16LE(base) + pcm.readInt16LE(base + 2);
    }
    out.writeInt16LE(Math.round(sum / (DECIMATION * INPUT_CHANNELS)), i * 2);
  }
  return out;
}

/** 16kHz モノラル PCM の長さ（秒） */
export function durationSec(pcm) {
  return pcm.length / 2 / OUTPUT_SAMPLE_RATE;
}

/** 音量の目安（RMS） */
export function rms(pcm) {
  const n = pcm.length / 2;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** 16kHz モノラル PCM に WAV ヘッダを付ける */
export function toWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // モノラル
  header.writeUInt32LE(OUTPUT_SAMPLE_RATE, 24);
  header.writeUInt32LE(OUTPUT_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
