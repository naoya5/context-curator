# context-curator

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

## インストール / 実行

```bash
npm install
npx tsx src/cli.ts <command>   # 開発実行
# または
npm run build && npm link      # curator コマンドとして
```

## コマンド

| コマンド | 説明 |
|---|---|
| `curator scan` | 資産台帳の構築・表示（フル再スキャン） |
| `curator usage` | transcript ledger の更新 + 使用統計表示。`--days N` `--rebuild` |
| `curator check` | scan + usage + ポリシー評価。`--filter stale\|unused\|bloated\|zombie` |
| `curator cost` | Context Health Score レポート（実行ごとに `~/.curator/history.jsonl` へ記録） |
| `curator apply` | 検出結果を1件ずつ承認してアーカイブ。`--dry-run` `--yes` `--ids` `--filter` |
| `curator restore` | アーカイブ一覧 / `restore <archiveId>` で復元（衝突時は中止・上書きしない） |
| `curator mcp` | プロジェクト × MCP サーバー使用マトリクスと無効化候補の提案（表示のみ） |
| `curator cost --history` | Health Score の時系列推移（スパークライン付き） |
| `curator install-skill` | `/curator` スキルラッパーを `~/.claude/skills/curator/` にインストール |

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
  staleDays: 30
  unusedGraceDays: 14
  bloat:
    claudeMdTokens: 3000
    skillFullTokens: 8000
    memoryFileTokens: 2000
ignore:
  - "skill:daily-commit"
```

## 安全性

- **v0.1 は `~/.claude` に対して完全 read-only**。書き込みは `~/.curator/` のみ
- トークン数は `~` 付きの推定値。MCP server の footprint は偽精度を避けて unknown 表示

## ロードマップ

- ~~v0.2: 承認制 archive（復元可能な片付け）/ 重複スキル検出~~ ✅ 完了
- ~~v0.3: MCP active-set 提案 / `/curator` スキルラッパー / Health Score 時系列 / `--all-projects`~~ ✅ 完了
- v0.4 候補: npm 公開 / MCP 無効化の承認制 apply 統合 / memory 内容 lint（古い事実・矛盾検出）

## 開発

```bash
npx tsc --noEmit && npx vitest run   # 型チェック + テスト（134 tests）
```

設計書: [docs/DESIGN.md](docs/DESIGN.md)

## License

MIT
