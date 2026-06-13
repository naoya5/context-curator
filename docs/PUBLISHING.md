# Publishing Guide

context-curator を npm に公開するための手順書。

---

## 前提条件

- Node.js >= 20
- npm アカウント（`npmjs.com`）
- `npm whoami` でログイン済みであること

---

## 公開手順

### 1. npm ログイン

```bash
npm login
# ブラウザが開いて OTP / パスワード認証が行われる
npm whoami   # ユーザー名が表示されれば OK
```

### 2. バージョン bump

```bash
# patch / minor / major を適宜選択
npm version patch   # 例: 0.4.0 → 0.4.1
npm version minor   # 例: 0.4.0 → 0.5.0
npm version major   # 例: 0.4.0 → 1.0.0
```

バージョン bump 後は `CHANGELOG.md` を更新してコミットする。

### 3. dry-run で同梱物を確認

```bash
npm publish --dry-run
```

確認ポイント:

- `dist/` — コンパイル済み JS と型定義
- `skill/SKILL.md` — Claude Code スキルファイル
- `README.md`, `CHANGELOG.md`, `LICENSE` — ドキュメント類
- `src/`, `test/`, `docs/DESIGN.md` が **含まれていないこと**

### 4. prepublishOnly の自動実行を確認

`npm publish` 実行時に自動で以下が走る（`package.json` の `prepublishOnly` スクリプト）:

```
npm run typecheck   # TypeScript 型チェック
npm run test        # 255 tests
npm run build       # tsc → dist/
```

いずれかが失敗した場合は publish は中断される。

### 5. 本番公開

```bash
npm publish
```

公開後 `https://www.npmjs.com/package/context-curator` で確認できる。

---

## 公開後の動線

### グローバルインストール

```bash
npm install -g context-curator
curator --version   # 0.4.x が表示されること
```

### スキルのインストール

```bash
curator install-skill
# → ~/.claude/skills/curator/SKILL.md にコピーされる
```

インストール済みの場合は `--force` で上書き:

```bash
curator install-skill --force
```

### /curator スキルの確認

Claude Code で `/curator` と入力してスキルが利用可能なことを確認する。

---

## バージョン bump の流れ

1. `CHANGELOG.md` に変更内容を追記
2. `npm version <patch|minor|major>` でバージョン更新（package.json + git tag）
3. `git push && git push --tags`
4. `npm publish`（prepublishOnly が自動でビルド・テストを実行）

---

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| `npm publish` でテストが失敗 | `npm run test` でエラーを確認し修正 |
| `skill/SKILL.md が見つかりません` | npm pack --dry-run で skill/ が含まれているか確認 |
| `curator: command not found` | `npm install -g context-curator` が完了しているか確認。PATH に npm global bin が含まれているか確認 |
| install-skill で既存ファイルエラー | `curator install-skill --force` で上書き |
