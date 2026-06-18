# context-curator

![tests](https://img.shields.io/badge/tests-296%20passing-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)

**Claude Code 環境の「コンテキスト資産」ライフサイクル管理 CLI。**

skills / MCP servers / CLAUDE.md / memory / commands / agents を台帳化し、
transcript 解析による**実態使用統計**を蓄積して、使われていない・肥大した資産を
理由付きで報告します。

```
$ curator cost

Context Health Report (2026-06-11)
══════════════════════════════════════════════════
起動時コンテキスト寄与（常時ロード分・推定）

  CLAUDE.md × 9                     ~2.4K tokens
  memory × 42                       ~1.2K tokens
  skills frontmatter × 12           ~1.6K tokens
  MCP servers × 3                   (unknown — tool定義は実測不能)
  ────────────────────────────────────────────────
  合計（推定可能分）                 ~5.2K tokens

  うち stale/unused 資産の寄与:  ~575 tokens (11%)

  Context Health Score: 89/100  [██████████████████░░]
```

## なぜ作ったか

Claude Code を使い込むほど、skills・MCP サーバー・CLAUDE.md・memory が溜まり、
**毎セッションの初期コンテキストを静かに圧迫していく**。既存ツールは「検出」止まりで、

- どの資産が**実際に**使われているか（transcript 由来の使用統計）
- 30日でローテートされる transcript を超えた**長期の使用履歴**
- TTL・しきい値を**自分のポリシー**として宣言する仕組み

が存在しなかった。context-curator はこの3つを核に、検出のその先 —
資産の一生（作成 → 使用 → 陳腐化 → 整理）の管理を引き受ける。

## インストール

```bash
# グローバルインストール（公開後）
npm install -g context-curator

# または開発版を直接
git clone https://github.com/naoya5/context-curator.git
cd context-curator && npm install && npm run build && npm link
```

> 公開前のローカル開発では `npm install` 後に `npx tsx src/cli.ts <command>` で
> 直接実行できる（ビルド不要）。以降の例の `curator` を `npx tsx src/cli.ts` に読み替え。

## Getting Started

最初の一巡り。すべて read-only なので安心して試せる。

```bash
# 1. 環境の健全性を一目で見る（初期コンテキストの何%が未使用資産か）
curator cost

# 2. 何が問題かを一覧する（stale / unused / bloated / duplicate / lint）
curator check

# 3. 片付け候補を「書き込みなし」で確認する
curator apply --dry-run

# 4. 納得したら1件ずつ承認してアーカイブ（消さずに ~/.curator/archive/ へ退避）
curator apply

# 5. 戻したくなったら
curator restore                 # アーカイブ一覧
curator restore <archiveId>     # 復元

# 6. Claude Code から自然文で使えるようにする
curator install-skill           # /curator スキルを ~/.claude/skills/ に導入
```

定期実行（cron / launchd）で `curator cost` を回すと、`curator cost --history` で
健全性スコアの推移が見える。

## コマンド

| コマンド | 説明 |
|---|---|
| `curator scan` | 資産台帳の構築・表示（フル再スキャン） |
| `curator usage` | transcript ledger の更新 + 使用統計表示。`--days N` `--rebuild` |
| `curator check` | scan + usage + ポリシー評価 + memory lint。`--filter stale\|unused\|bloated\|zombie\|duplicate\|lint` |
| `curator cost` | Context Health Score レポート（実行ごとに `~/.curator/history.jsonl` へ記録） |
| `curator apply` | 検出結果を1件ずつ承認してアーカイブ。`--dry-run` `--yes` `--ids` `--filter` |
| `curator restore` | アーカイブ一覧 / `restore <archiveId>` で復元（衝突時は中止・上書きしない） |
| `curator mcp` | プロジェクト × MCP サーバー使用マトリクスと無効化候補の提案 |
| `curator mcp --apply` | プロジェクト定義（.mcp.json）の未使用サーバーを承認制で無効化 |
| `curator cost --history` | Health Score の時系列推移（スパークライン付き） |
| `curator install-skill` | `/curator` スキルラッパーを `~/.claude/skills/curator/` にインストール |
| `curator dashboard` | 自己完結 HTML の可視化ダッシュボードを生成。`--out` `--open` `--all-projects` |

`scan` / `check` / `cost` は `--all-projects` で全プロジェクトの project スコープ資産を統合できる。

全コマンド `--json` 対応。`check` は high severity 検出時に exit 1（CI 組み込み用）。

**apply の哲学: 絶対に消さない。** すべて `~/.curator/archive/` への移動で、いつでも戻せる。
mcp-server は設定 JSON からのエントリ除去（編集前に必ず backup + atomic write）。
plugin 由来の資産は提案対象外（プラグインを壊さない）。

## 仕組み

- **Usage Ledger**: `~/.claude/projects/**/*.jsonl`（Claude Code transcript）から
  Skill / MCP tool / Agent の呼び出しイベントを抽出し、`~/.curator/ledger.jsonl` に増分蓄積。
  transcript の約30日ローテーションを超えて履歴を保持する
- **Policy Engine**: `~/.curator/config.yaml` で TTL・しきい値を宣言（なければ内蔵デフォルト）

```yaml
policy:
  staleDays: 30           # 最終使用がこれより古い → stale
  unusedGraceDays: 14     # 一度も使われず、作成からこの日数を超えたら → unused
  duplicateThreshold: 0.65 # スキル重複判定の Jaccard 類似度しきい値
  bloat:
    claudeMdTokens: 3000
    skillFullTokens: 8000
    memoryFileTokens: 2000
  memoryLint:
    oldDateDays: 180      # 本文の最新日付がこれより古い → [old-date]
    duplicateThreshold: 0.7 # memory 近似重複の Jaccard しきい値
ignore:
  - "skill:daily-commit"  # asset id（glob 可）。検出から除外
```

全項目の詳細は [docs/CONFIG.md](docs/CONFIG.md)、コピー用テンプレートは
[config.example.yaml](config.example.yaml) を参照。

## 安全性

このツールはあなたの Claude Code 環境を直接さわる。だから安全モデルを明示する。

- **分析系（`scan` / `usage` / `check` / `cost` / `mcp`）は `~/.claude` に対して read-only。** これらが書き込むのは `~/.curator/`（ledger・履歴）だけ
- **書き込みを伴うのは承認済み操作だけ**：`apply`（アーカイブ）・`restore`（復元）・`mcp --apply`（プロジェクトの MCP 無効化）・`install-skill`。いずれも対話承認または明示フラグが要る
- **絶対に削除しない。** すべて `~/.curator/archive/` への移動で、`curator restore` でいつでも戻せる（クロスデバイス移動の fallback 1箇所を除き、コードベースに削除呼び出しは存在しない）
- **設定 JSON を編集する前に必ず backup。** `~/.claude.json` や project の `settings.json` をいじる前に `~/.curator/backups/` にフルコピーを取り、tmp ファイル + rename の atomic write で書き換える。パース失敗時は何も触らず中止する
- **すべての変更操作は `~/.curator/journal.jsonl` に追記記録**（append-only の監査ログ）
- **plugin 由来の資産は提案対象外**（プラグインを壊さない）
- トークン数は `~` 付きの推定値。MCP server の footprint は偽精度を避けて unknown 表示

## ロードマップ

- ~~v0.2: 承認制 archive（復元可能な片付け）/ 重複スキル検出~~ ✅ 完了
- ~~v0.3: MCP active-set 提案 / `/curator` スキルラッパー / Health Score 時系列 / `--all-projects`~~ ✅ 完了
- ~~v0.4: npm 公開準備 / mcp --apply / memory 内容 lint~~ ✅ 完了（publish 手順は [docs/PUBLISHING.md](docs/PUBLISHING.md)）
- ~~v0.5: Observability ダッシュボード（自己完結 HTML）~~ ✅ 完了（`curator dashboard`）

memory lint の限界: 静的解析のため意味的な矛盾・正確性は検出できない。LLM による内容レビューは
`/curator` スキル経由の運用（check 結果を Claude に読ませる）に委ね、CLI は候補提示に徹する。

## 開発

```bash
npm ci
npm run typecheck && npm test   # 型チェック + テスト（296 tests）
npm run build                   # dist/ へコンパイル
```

設計書: [docs/DESIGN.md](docs/DESIGN.md)

## Contributing

PR・Issue を歓迎します。開発環境・テスト方針・**設計の不変条件**（read-only / 削除しない /
ダッシュボードの自己完結性など）は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## License

[MIT](LICENSE) © naoya5
