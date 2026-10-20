# 完了タスクの時系列

- 2026-10-15: Node.js + discord.js + @discordjs/voice + Whisper API + claude -p で Bot の初版を実装
- 2026-10-15: git 管理を開始し、GitHub に public リポジトリ discord-vc-summary を作成して push
- 2026-10-15: ライセンスを The Unlicense に設定して push
- 2026-10-15: 文字起こしを gpt-4o-transcribe、要約を claude-opus-5-5 に設定し、実機での動作を確認
- 2026-10-15: 聞き専チャンネルのチャット発言を議事録に含める機能を実装
- 2026-10-15: 聞き専チャンネル機能を実機で確認し、コミット・push
- 2026-10-20: opusscript のバグで Opus デコードが落ちる問題を特定し、@discordjs/opus に置き換え
- 2026-10-20: Opus デコード修正を実機で確認し、コミット・push
- 2026-10-20: 要約の文字数制限を撤廃し、2000 文字超は txt 添付で送るよう変更
- 2026-10-20: 文字起こしの原文を 8MB 以下なら txt 添付で DM に送るよう変更
- 2026-10-20: 要約の文字数制限撤廃と原文の添付を実機で確認し、コミット・push
