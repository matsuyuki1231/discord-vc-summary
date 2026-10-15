# vc-summary

Discord の VC を参加者ごとに文字起こし（Whisper API）し、`claude -p` で要約して DM に届ける Bot です。

## AIの使用について
このプロジェクトはほぼ全てのコードがClaude Codeによって記述されました。
機能仕様と技術選定についてはmatsuyuki1231が指示を行いましたが、詳細な技術仕様についてはClaudeの判断が多く含まれます。

## コマンド

どのコマンドも、実行した時点で VC に参加している人だけが使えます（`/summary` と `/stop` は録音中の VC に限ります）。

| コマンド | 動作 |
|---|---|
| `/start` | 実行者がいる VC に Bot が参加し、録音を始める。実行したチャンネルで VC にいる全員をメンションし、録音中であることを知らせる |
| `/summary` | ここまでの要約を実行者の DM にだけ送る（録音は続く）。`/start` したチャンネルには「〇〇さんの DM に要約を送った」旨だけを投稿する |
| `/stop` | 録音を終了し、その時点で VC にいる全員の DM に要約を送る（途中で退出した人には送らない）。`/start` したチャンネルには送った旨だけを投稿する |

- `/start` を実行したチャンネルは聞き専チャンネルとして扱い、録音中の VC に参加している人のチャット発言も議事録に含めます（VC にいない人の発言は含めません）
- 録音中に VC へ入ってきた人には、`/start` したチャンネルでメンションして録音中であることを知らせます
- VC が 0 人になっても Bot は退出せず、録音を続けます
- Bot が VC から切断された（キックされた等）場合は、`/stop` と同じ扱いで終了します

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成し、Bot トークンを取得する。Bot ページの Privileged Gateway Intents で **Message Content Intent** をオンにする（聞き専チャンネルの発言を読むため）
2. OAuth2 → URL Generator で、scope に `bot` と `applications.commands` を、権限に `View Channels` / `Send Messages` / `Connect` を付けてサーバーに招待する
3. Bot を動かすマシンに Claude Code をインストールし、`claude` でログインしておく
4. 設定ファイルを用意して起動する

```sh
npm install
cp .env.example .env   # DISCORD_TOKEN と OPENAI_API_KEY を記入
npm start
```

起動すると、Bot が参加している各サーバーにスラッシュコマンドが登録されます。

## 仕組み

- Discord は話者ごとに別の音声ストリームを送ってくるので、ユーザー単位で受信します。1 秒無音が続いたところで 1 発話として区切ります
- 0.6 秒未満の発話や音量の小さい発話は、物音とみなして捨てます（Whisper の幻聴対策を兼ねています）
- 発話ごとに Whisper API で文字起こしし、`[時刻] 名前: 発言` の形で時刻順に並べた議事録（チャット発言は `名前（チャット）` と表記）を `claude -p` に渡します
- VC の発言がそのまま Claude への入力になるため、`claude -p` はツール・MCP サーバー・設定ファイルをすべて無効にし、空のディレクトリで実行しています

## 注意

- 議事録は Bot のメモリ上にだけ保持します。`/stop` の前に Bot を止めると、それまでの内容は失われます
- 要約は Claude Code のログインアカウントの利用枠を使います

## ライセンス

[The Unlicense](LICENSE)（パブリックドメイン）
