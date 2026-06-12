# Changelog

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
