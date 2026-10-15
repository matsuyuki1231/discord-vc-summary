import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { Session } from './session.js';
import { summarize } from './summarize.js';

for (const key of ['DISCORD_TOKEN', 'OPENAI_API_KEY']) {
  if (!process.env[key]) {
    console.error(`環境変数 ${key} が設定されていません（.env を確認してください）`);
    process.exit(1);
  }
}

const DISCORD_MESSAGE_LIMIT = 2000;

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('参加中のVCで録音・文字起こしを開始します'),
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('ここまでの要約をあなたのDMに送ります（録音は続きます）'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('録音を終了し、今VCにいる全員のDMに要約を送ります'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

/** guildId → Session */
const sessions = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  // ギルドコマンドとして登録すると即座に反映される
  for (const guild of c.guilds.cache.values()) await registerCommands(guild);
  console.log(`${c.user.tag} としてログインしました`);
});

client.on(Events.GuildCreate, registerCommands);

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`コマンド登録に失敗しました (${guild.name}):`, err.message);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  try {
    switch (interaction.commandName) {
      case 'start':
        return await handleStart(interaction);
      case 'summary':
        return await handleSummary(interaction);
      case 'stop':
        return await handleStop(interaction);
    }
  } catch (err) {
    console.error(`/${interaction.commandName} の処理に失敗しました:`, err);
    const content = '⚠️ エラーが発生しました。';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

/** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} interaction */
async function handleStart(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: 'VCに参加してから実行してください。', flags: MessageFlags.Ephemeral });
  }
  const existing = sessions.get(interaction.guildId);
  if (existing) {
    return interaction.reply({
      content: `既に ${existing.voiceChannel} で録音中です。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const session = new Session(voiceChannel, interaction.channel);
  // 接続待ちの間に /start が重ねて実行されないよう、先に登録しておく
  sessions.set(interaction.guildId, session);
  await interaction.deferReply();
  try {
    await session.start();
  } catch (err) {
    sessions.delete(interaction.guildId);
    console.error('VCへの接続に失敗しました:', err);
    return interaction.editReply('⚠️ VCに接続できませんでした。Botの権限（接続・発言）を確認してください。');
  }
  session.onLost = () =>
    finishSession(session, '⚠️ BotがVCから切断されたため、録音を終了しました。').catch((err) =>
      console.error('切断時の終了処理に失敗しました:', err),
    );

  const members = session.currentMembers();
  await interaction.editReply({
    content: [
      `🔴 ${voiceChannel} の録音・文字起こしを開始しました。`,
      members.length > 0 ? `${members.join(' ')} このVCの音声は録音され、文字起こしと要約に使われます。` : '',
    ].filter(Boolean).join('\n'),
    allowedMentions: { users: members.map((m) => m.id) },
  });
}

/** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} interaction */
async function handleSummary(interaction) {
  const session = await requireSessionMember(interaction);
  if (!session) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await session.settle();
  const body = await buildSummary(session);
  const failed = await sendDMs([interaction.member], body);
  if (failed.length > 0) {
    return interaction.editReply('⚠️ DMを送れませんでした。サーバーメンバーからのDMを許可しているか確認してください。');
  }

  await session.textChannel.send({
    content: `📨 **${interaction.member.displayName}** さんの要求で、ここまでの要約を **${interaction.member.displayName}** さんのDMに送りました。`,
    allowedMentions: { parse: [] },
  });
  await interaction.editReply('📨 DMに要約を送りました。');
}

/** @param {import('discord.js').ChatInputCommandInteraction<'cached'>} interaction */
async function handleStop(interaction) {
  const session = await requireSessionMember(interaction);
  if (!session) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await finishSession(session, '⏹️ 録音を終了しました。');
  await interaction.editReply('⏹️ 録音を終了しました。');
}

/**
 * 録音を終了し、その時点でVCにいる人全員に要約をDMで送る。
 * /stop と、BotがVCから切断されたときの両方で使う。
 */
async function finishSession(session, headline) {
  if (sessions.get(session.voiceChannel.guild.id) !== session) return; // 既に終了処理済み
  sessions.delete(session.voiceChannel.guild.id);

  // 途中退出した人には送らないため、宛先は終了した時点のVC参加者に限る
  const recipients = session.currentMembers();
  session.stop();
  await session.settle();

  if (recipients.length === 0) {
    await session.textChannel.send(`${headline}\nVCに誰もいなかったため、要約は送信していません。`);
    return;
  }

  let body;
  try {
    body = await buildSummary(session);
  } catch (err) {
    console.error('要約の作成に失敗しました:', err);
    await session.textChannel.send(`${headline}\n⚠️ 要約の作成に失敗したため、DMは送信していません。`);
    return;
  }
  const failed = await sendDMs(recipients, body);
  const sent = recipients.filter((m) => !failed.includes(m));

  const lines = [headline];
  if (sent.length > 0) {
    lines.push(`📨 VCにいた ${sent.map((m) => `**${m.displayName}**`).join('、')} さんのDMに要約を送りました。`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ ${failed.map((m) => `**${m.displayName}**`).join('、')} さんにはDMを送れませんでした（DMが閉じられている可能性があります）。`);
  }
  await session.textChannel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

/** 実行者が録音中のVCに参加しているか確認し、セッションを返す */
async function requireSessionMember(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({ content: '現在録音していません。', flags: MessageFlags.Ephemeral });
    return null;
  }
  if (!session.isInVoice(interaction.user.id)) {
    await interaction.reply({
      content: `録音中のVC（${session.voiceChannel}）に参加している人だけが実行できます。`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return session;
}

async function buildSummary(session) {
  const range = `${formatTime(session.startedAt)}〜${formatTime(new Date())}`;
  const header = `📝 **${session.voiceChannel.guild.name} / ${session.voiceChannel.name}** の要約（${range}）`;
  const transcript = session.transcript();
  if (!transcript) return `${header}\n\n記録された発言はありませんでした。`;
  return `${header}\n\n${await summarize(transcript)}`;
}

function formatTime(date) {
  return date.toLocaleString('ja-JP', {
    timeZone: process.env.TZ || 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** @returns {Promise<import('discord.js').GuildMember[]>} DMを送れなかったメンバー */
async function sendDMs(members, body) {
  const chunks = splitMessage(body);
  const failed = [];
  for (const member of members) {
    try {
      for (const chunk of chunks) await member.send({ content: chunk, allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn(`DMの送信に失敗しました (${member.user.tag}):`, err.message);
      failed.push(member);
    }
  }
  return failed;
}

/** Discord の文字数制限に収まるよう、行単位で分割する */
function splitMessage(text) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    // 1 行だけで制限を超える場合は強制的に切る
    for (let i = 0; i < line.length || i === 0; i += DISCORD_MESSAGE_LIMIT) {
      const piece = line.slice(i, i + DISCORD_MESSAGE_LIMIT);
      if (current.length + piece.length + 1 > DISCORD_MESSAGE_LIMIT) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// 録音中のVCに入ってきた人へ、/start を実行したチャンネルで録音中であることを知らせる
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const session = sessions.get(newState.guild.id);
  if (!session || session.stopped || newState.member?.user.bot) return;
  if (newState.channelId !== session.voiceChannel.id || oldState.channelId === newState.channelId) return;

  await session.textChannel
    .send({
      content: `${newState.member} このVCは現在録音・文字起こし中です。音声は要約の作成に使われます。`,
      allowedMentions: { users: [newState.id] },
    })
    .catch((err) => console.warn('入室通知の送信に失敗しました:', err.message));
});

// 終了時は VC から抜けてからプロセスを終える
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const session of sessions.values()) session.stop();
    client.destroy().finally(() => process.exit(0));
  });
}

client.login(process.env.DISCORD_TOKEN);
