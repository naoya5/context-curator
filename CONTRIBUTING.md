# Contributing to context-curator

開発に参加してくれてありがとう。このプロジェクトは小さく、設計の一貫性を重視しています。

## 開発環境

- Node.js >= 20
- 依存のインストール: `npm ci`

```bash
npm run dev -- scan        # ソースを直接実行（tsx、ビルド不要）
npm run typecheck          # 型チェック（tsc --noEmit）
npm test                   # vitest（全テスト）
npm run build              # dist/ へコンパイル
```

## 設計の不変条件（PR で必ず守ること）

このツールはユーザーの Claude Code 環境を直接さわるため、安全性が最優先です。
以下はレビューで必ず確認される不変条件です。

1. **分析系は read-only**：`scan` / `usage` / `check` / `cost` / `mcp`（無印）は
   `~/.claude` を読み取るだけ。書き込み先は `~/.curator/` のみ
2. **書き込みは承認済み操作だけ**：`apply` / `restore` / `mcp --apply` / `install-skill`。
   いずれも対話承認または明示フラグを要求する
3. **削除しない**：資産は `~/.curator/archive/` へ**移動**する。コードベースに削除呼び出しは
   クロスデバイス移動の fallback 1箇所（`src/apply/archive-move.ts`）以外に存在してはならない
4. **設定 JSON 編集は backup + atomic write**：パース失敗時は中止。`src/apply/claudejson.ts` の
   `safeEditJson` を経由する
5. **ダッシュボードは完全自己完結**：外部 CDN/ネットワークリソース禁止、`<script>` タグ禁止、
   全動的文字列を HTML エスケープ、`renderDashboardHtml` は I/O のない純関数
6. **トークンは推定**：`~` 付きで表示し、MCP サーバーの footprint は `unknown` と正直に出す
   （偽精度を出さない）
7. **クラッシュさせない**：scanner / parser は対象不在・壊れたデータで例外を投げず、
   空配列 + 警告カウントで継続する
8. **実行時依存は最小限**：現在は `commander` / `picocolors` / `yaml` の 3 つ。追加は慎重に

## テスト方針

- フレームワークは **vitest**
- ファイル I/O を伴うテストは `os.tmpdir()` のサンドボックスに限定し、
  **実 `~/.claude` / `~/.curator` には絶対に触れない**（パスは `CURATOR_CLAUDE_DIR` /
  `CURATOR_HOME` / `CURATOR_CLAUDE_JSON` で差し替える）
- 安全クリティカルな経路（archive/restore）は実バイナリ E2E（`test/e2e-cli.test.ts`）でも担保
- 新機能・バグ修正には必ずテストを添える

## コミット / PR

- コミットは [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` /
  `docs:` / `test:` / `refactor:` / `chore:` など）
- PR 前に `npm run typecheck && npm test && npm run build` が全て通ること
- 設計判断は `docs/DESIGN.md` に記録する慣習（大きな変更は §追記）

## 質問・提案

Issue を歓迎します。バグ報告は再現手順、機能提案はユースケースを添えてください。
