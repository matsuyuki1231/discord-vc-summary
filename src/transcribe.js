import { toWav } from './audio.js';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_ATTEMPTS = 3;

// 無音やノイズに対して Whisper が出しがちな定型文。これと完全一致する結果は捨てる
// （「ありがとうございました」など実際の発言でもあり得るものは含めない）
const HALLUCINATIONS = new Set([
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございました。',
  'チャンネル登録をお願いします',
  'チャンネル登録をお願いします。',
  'チャンネル登録よろしくお願いします',
  'チャンネル登録よろしくお願いします。',
]);

/**
 * 16kHz モノラル PCM を Whisper API で文字起こしする。
 * @param {Buffer} pcm
 * @param {string} prompt 固有名詞（参加者名など）を伝えて誤変換を減らすためのヒント
 * @returns {Promise<string>} 文字起こし結果。不要と判断したものは空文字
 */
export async function transcribe(pcm, prompt) {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    form.append('language', 'ja');
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (res.ok) {
      const text = ((await res.json()).text ?? '').trim();
      return HALLUCINATIONS.has(text) ? '' : text;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`Whisper API エラー: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}
