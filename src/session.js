import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import opus from '@discordjs/opus';
import { durationSec, rms, toMono16k, OUTPUT_SAMPLE_RATE } from './audio.js';
import { transcribe } from './transcribe.js';

// 発話の区切り: この時間無音が続いたら 1 発話とみなす
const SILENCE_MS = 1000;
// これより短い・小さい発話は咳や物音とみなして捨てる（幻聴対策も兼ねる）
const MIN_SEGMENT_SEC = 0.6;
const MIN_RMS = 150;
// 長く話し続けた場合でも Whisper の 25MB 制限に余裕で収まるよう、この長さで区切る
const MAX_SEGMENT_BYTES = 5 * 60 * OUTPUT_SAMPLE_RATE * 2;
// Whisper API の同時リクエスト数
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

const timeFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: process.env.TZ || 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * 1 つの VC に対する録音・文字起こしセッション。
 * Discord は話者ごとに別の音声ストリームを送ってくるので、ユーザー単位で受信して文字起こしする。
 */
export class Session {
  /**
   * @param {import('discord.js').VoiceBasedChannel} voiceChannel
   * @param {import('discord.js').TextBasedChannel} textChannel /start が実行されたチャンネル（通知先）
   */
  constructor(voiceChannel, textChannel) {
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.startedAt = new Date();
    /** @type {{ at: number, userId: string, name: string, text: string, source: 'voice' | 'chat' }[]} */
    this.entries = [];
    /** 文字起こし待ち・実行中の Promise */
    this.pending = new Set();
    /** 受信中の発話（userId → 発話を確定させる関数） */
    this.activeCaptures = new Map();
    this.queue = [];
    this.running = 0;
    this.connection = null;
    this.stopped = false;
    /** Bot が VC から切断されて戻れなかったときに呼ばれる */
    this.onLost = null;
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // 音声を受信するため
      selfMute: true,
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      this.connection.destroy();
      throw err;
    }
    this.connection.receiver.speaking.on('start', (userId) => this.capture(userId));

    // 一時的な切断なら自動で再接続される。戻らなければ（キックされた等）onLost を呼ぶ
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopped) this.onLost?.();
      }
    });
  }

  /** 現在 VC にいる Bot 以外のメンバー */
  currentMembers() {
    return [...this.voiceChannel.members.values()].filter((m) => !m.user.bot);
  }

  isInVoice(userId) {
    return this.voiceChannel.members.has(userId);
  }

  capture(userId) {
    if (this.stopped || this.activeCaptures.has(userId)) return;
    const member = this.voiceChannel.guild.members.cache.get(userId);
    if (member?.user.bot) return;

    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    // @discordjs/opus は OpusEncoder クラスがデコードも担う
    const decoder = new opus.OpusEncoder(48000, 2);
    let chunks = [];
    let bytes = 0;
    let segmentStart = Date.now();

    const flush = () => {
      if (bytes > 0) this.enqueue(userId, segmentStart, Buffer.concat(chunks));
      chunks = [];
      bytes = 0;
      segmentStart = Date.now();
    };

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      flush();
      this.activeCaptures.delete(userId);
      stream.destroy();
    };

    stream.on('data', (packet) => {
      try {
        const pcm = toMono16k(decoder.decode(packet));
        chunks.push(pcm);
        bytes += pcm.length;
        if (bytes >= MAX_SEGMENT_BYTES) flush();
      } catch (err) {
        console.warn(`Opus のデコードに失敗しました (${userId}):`, err.message);
      }
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', (err) => {
      console.warn(`音声ストリームのエラー (${userId}):`, err.message);
      finish();
    });

    this.activeCaptures.set(userId, finish);
  }

  enqueue(userId, at, pcm) {
    if (durationSec(pcm) < MIN_SEGMENT_SEC || rms(pcm) < MIN_RMS) return;

    const job = new Promise((resolve) => this.queue.push({ userId, at, pcm, resolve }));
    this.pending.add(job);
    job.finally(() => this.pending.delete(job));
    this.drain();
  }

  drain() {
    while (this.running < MAX_CONCURRENT_TRANSCRIPTIONS && this.queue.length > 0) {
      const { userId, at, pcm, resolve } = this.queue.shift();
      this.running++;
      this.transcribeSegment(userId, at, pcm)
        .catch((err) => console.error('文字起こしに失敗しました:', err.message))
        .finally(() => {
          this.running--;
          resolve();
          this.drain();
        });
    }
  }

  async transcribeSegment(userId, at, pcm) {
    const text = await transcribe(pcm, this.whisperPrompt());
    if (!text) return;
    this.entries.push({ at, userId, name: this.displayName(userId), text, source: 'voice' });
  }

  /**
   * 聞き専チャンネル（/start を実行したチャンネル）でのチャット発言を議事録に加える。
   * 関係のない雑談を拾わないよう、録音中の VC に参加している人の発言だけを対象にする。
   * @param {import('discord.js').Message} message
   */
  addChatMessage(message) {
    if (this.stopped || message.author.bot || !this.isInVoice(message.author.id)) return;
    // cleanContent はメンションを名前に置き換えた本文
    const text = message.cleanContent.trim();
    if (!text) return;
    this.entries.push({
      at: message.createdTimestamp,
      userId: message.author.id,
      name: this.displayName(message.author.id),
      text,
      source: 'chat',
    });
  }

  displayName(userId) {
    return this.voiceChannel.guild.members.cache.get(userId)?.displayName ?? `user-${userId}`;
  }

  /** Whisper に参加者名を伝え、名前の誤変換を減らす */
  whisperPrompt() {
    const names = this.currentMembers().map((m) => m.displayName);
    return names.length > 0 ? `参加者: ${names.join('、')}` : '';
  }

  /**
   * 文字起こし待ちの発話がすべて処理されるまで待つ。
   * 途中経過の要約では話している最中の発話を切らないよう、受信中の発話は待たない
   * （stop() 後に呼べば、受信中だった発話も確定済みなので含まれる）。
   */
  async settle() {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** 時刻順に並べた議事録テキスト */
  transcript() {
    return [...this.entries]
      .sort((a, b) => a.at - b.at)
      .map((e) => `[${timeFormat.format(e.at)}] ${e.name}${e.source === 'chat' ? '（チャット）' : ''}: ${e.text}`)
      .join('\n');
  }

  /** 録音を止めて VC から退出する。文字起こし待ちの処理は settle() で待つ */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const finish of [...this.activeCaptures.values()]) finish();
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
  }
}
