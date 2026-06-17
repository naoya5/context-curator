# Changelog

## 0.5.0 (2026-06-17)

### Added
- `curator dashboard [--out <path>] [--open] [--all-projects]` — 自己完結 HTML の
  Observability ダッシュボードを生成。Context Health Score（SVG ドーナツゲージ）、
  スコア時系列（SVG 折れ線）、資産内訳、findings を1枚で可視化
- 完全オフライン: 外部 CDN/ネットワークリソース不使用、チャートは手書き inline SVG、
  全動的文字列を HTML エスケープ（read-only。出力 HTML を書くだけで `~/.claude` は触らない）

### Tests
- `apply → restore` 安全クリティカル経路の実バイナリ E2E 回帰テストを追加
- dashboard レンダリング（エスケープ/自己完結/集計）の単体テスト 39 件追加 — 計 296 tests

## 0.4.0 (2026-06-13)

### Added
- npm 公開準備 — `files` / `prepublishOnly` / LICENSE / `docs/PUBLISHING.md`（publish はユーザー操作）
- `curator mcp --apply [--dry-run] [--yes]` — プロジェクト `.mcp.json` 定義サーバーのうち
  未使用のものを、そのプロジェクトの `.claude/settings.json` の `disabledMcpjsonServers` へ
  承認制で追記（backup + atomic write、journal 記録、グローバル定義サーバーは対象外）
- memory 内容 lint — `[old-date]` `[broken-link]` `[index-mismatch]` `[near-duplicate]` の
  静的検出を check に統合（`--filter lint`）。lint は archive 提案の対象外
- `policy.memoryLint`（oldDateDays: 180 / duplicateThreshold: 0.7）

### Fixed
- `--filter duplicate` が v0.2 以降 CLI のバリデーションで弾かれていた問題

## 0.3.0 (2026-06-13)

### Added
- `/curator` スキルラッパー（`skill/SKILL.md`）と `curator install-skill [--force]` —
  スキル自身のコンテキスト消費を最小化した薄い設計（frontmatter + コマンド対応表のみ）
- `curator mcp` — プロジェクト × MCP サーバーの使用マトリクスと、プロジェクト別の
  無効化候補（active-set）提案。`--days N` / `--all` 対応。表示のみ（設定編集はしない）
- `curator cost --history [--limit N]` — Health Score の時系列表示（スパークライン付き）
- `--all-projects`（scan / check / cost）— ledger に現れた全プロジェクトの
  project スコープ資産を統合してスキャン

## 0.2.0 (2026-06-13)

### Added
- `curator apply` — 承認制アーカイブ。check の検出結果（stale / unused / zombie / duplicate）から
  提案を構築し、1件ずつ `[y/n/q]` で確認して実行。`--dry-run` / `--yes` / `--ids` / `--filter` 対応
- `curator restore` — アーカイブ一覧表示と復元。復元先に衝突があれば中止（上書きしない）
- 重複スキル検出 — name + description の bigram Jaccard 類似度（日本語対応）。
  `policy.duplicateThreshold`（デフォルト 0.65）で調整可能
- `~/.curator/journal.jsonl` — apply / restore の append-only 監査ログ
- mcp-server のアーカイブ — 設定 JSON からのエントリ除去（backup 自動作成 + atomic write、
  manifest に復元情報を保存）

### Safety
- 削除は行わない。すべて `~/.curator/archive/` への移動で、`curator restore` でいつでも戻せる
- 設定 JSON 編集前に必ず `~/.curator/backups/` にフルコピーを作成
- rm 系 API はクロスデバイス移動の fallback 1箇所のみに限定

## 0.1.0 (2026-06-11)

- 初版: `scan` / `usage` / `check` / `cost`
- transcript JSONL 解析による使用統計と ledger 蓄積（30日ローテーション対策）
- YAML 宣言ポリシー（stale / unused / bloated / zombie）
- Context Health Score とレポート履歴（history.jsonl）
- `~/.claude` に対して完全 read-only
