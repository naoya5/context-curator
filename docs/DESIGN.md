# Context Curator — 設計書 v0.1

> 作成: 2026-06-11 / 設計: メインセッション (Fable 5) / 実装: Sonnet サブエージェント
> 根拠資料: `~/docs/second-brain/plans/20260611_プロダクトアイデア提案_Vault探索.md`

## 1. プロダクト定義

**Claude Code 環境の「コンテキスト資産」のライフサイクル管理 CLI。**
skills / MCP servers / CLAUDE.md / memory / commands / agents を台帳化し、transcript 解析による
実態使用統計を蓄積し、ポリシーに基づいて stale / bloated 資産を理由付きで報告する。

- パッケージ名: `context-curator`、CLI バイナリ名: `curator`
- TypeScript / Node.js >= 20 / ESM / 実行時依存は最小限（目標: `commander` + `yaml` + `picocolors` 程度。テストは `vitest`）
- **v0.1 は ~/.claude 等に対して完全 read-only**。書き込みは自前ディレクトリ `~/.curator/` のみ

### ポジショニングと差別化（競合調査 2026-06-11 より）

unclog（最接近競合、Python、検出専門）との関係: **「unclog は検出する。Curator は管理する」**

| 軸 | unclog | Context Curator |
|---|---|---|
| 使用統計のソース | `~/.claude/logs/session-*.log`（**環境によっては存在しない**。実機確認済み: 0件） | `~/.claude/projects/**/*.jsonl` transcript（実在・実機検証済み） |
| 履歴の保持 | 直近30日のみ（ログ依存） | **usage ledger に蓄積** → transcript の30日ローテを超えて履歴保持 |
| 削除 | 即時削除・アンドゥ不可 | v0.2 で承認制 archive（復元可能）。v0.1 は read-only |
| ポリシー | なし（固定30日） | YAML 宣言ポリシー（TTL/しきい値カスタム） |
| 定期実行 | なし | ledger 前提の定期実行（cron/launchd/loop） |
| ヘッドライン | リソース別ランキング | **Context Health Score**（初期コンテキストの何%が未使用資産か） |

## 2. リポジトリ構造

```
context-curator/
├── package.json            # type: module, bin: { curator: dist/cli.js }
├── tsconfig.json           # strict, NodeNext
├── src/
│   ├── cli.ts              # commander によるコマンドルーティング
│   ├── config.ts           # ~/.curator/config.yaml の読み込み + デフォルト値
│   ├── paths.ts            # パス解決（CLAUDE_CONFIG_DIR 環境変数対応、デフォルト ~/.claude）
│   ├── tokens.ts           # トークン見積もり
│   ├── types.ts            # Asset / UsageEvent / Finding 等の共有型
│   ├── scan/
│   │   ├── inventory.ts    # 全 scanner を集約し Inventory を構築
│   │   └── assets/
│   │       ├── skills.ts
│   │       ├── mcp.ts
│   │       ├── claudemd.ts
│   │       ├── memory.ts
│   │       ├── commands.ts
│   │       └── agents.ts
│   ├── usage/
│   │   ├── transcript.ts   # JSONL ストリームパーサ（1行ずつ、メモリに全載せしない）
│   │   ├── extract.ts      # tool_use → UsageEvent 抽出
│   │   └── ledger.ts       # ~/.curator/ledger.jsonl への増分蓄積 + state 管理
│   ├── policy/
│   │   ├── engine.ts       # Inventory + UsageIndex + Policy → Finding[]
│   │   └── rules.ts        # stale / unused / bloated / zombie の判定関数
│   └── report/
│       ├── check.ts        # curator check の出力
│       ├── cost.ts         # curator cost の出力（Health Score）
│       └── render.ts       # テーブル / カラー出力ヘルパ（--json で生データ）
├── test/                   # vitest。fixtures/ に合成 transcript・合成 ~/.claude を置く
└── docs/DESIGN.md          # 本書
```

## 3. データモデル

```ts
// types.ts
export type AssetKind =
  | 'skill' | 'mcp-server' | 'claude-md' | 'memory' | 'command' | 'agent';

export type AssetScope = 'user' | 'project' | 'plugin';

export interface Asset {
  id: string;             // `${kind}:${name}` をベースに一意化（重複時はパスを付加）
  kind: AssetKind;
  name: string;           // skill名 / mcp server名 / ファイル名
  path: string;           // 絶対パス（mcp-server は定義元 JSON のパス）
  scope: AssetScope;
  sizeBytes: number;
  /** 常時ロード分の推定トークン（下記 4.3 参照） */
  footprintTokens: number;
  /** 呼び出し時にロードされる全文の推定トークン */
  fullTokens: number;
  modifiedAt: string;     // ISO8601（birthtime は信頼しない）
  meta?: Record<string, unknown>; // skill の description、mcp の command 等
}

export interface UsageEvent {
  ts: string;             // ISO8601
  kind: 'skill' | 'mcp-tool' | 'agent';
  ref: string;            // skill名（プラグイン名前空間込み）/ mcp server名 / subagent_type
  tool?: string;          // mcp の場合の tool 名
  sessionId: string;
  cwd: string;
}

export interface UsageStats {
  ref: string;
  kind: UsageEvent['kind'];
  count: number;
  lastUsed: string | null;  // ledger 全期間での最終使用
  projects: string[];       // 使用された cwd の一覧（重複排除）
}

export type FindingType = 'stale' | 'unused' | 'bloated' | 'zombie';

export interface Finding {
  asset: Asset;
  type: FindingType;
  reason: string;          // 人間可読の理由。例: "最終使用 2026-04-02（70日前）/ しきい値 30日"
  severity: 'info' | 'warn' | 'high';
  suggestion: string;      // v0.1 は提案文言のみ（適用機能なし）
}
```

## 4. モジュール仕様

### 4.1 scan — Inventory Scanner

各 scanner は `(paths: ResolvedPaths) => Promise<Asset[]>`。存在しないディレクトリは静かにスキップ。

| scanner | 走査対象 | 備考 |
|---|---|---|
| skills | `~/.claude/skills/*/SKILL.md`、`<project>/.claude/skills/*/SKILL.md`、`~/.claude/plugins/*/skills/*/SKILL.md` | frontmatter（`---` 区切りの YAML）から `name`/`description` を抽出。footprint = frontmatter 部分、full = ファイル全体。プラグインスキルの name は `plugin:skill` 形式 |
| mcp | `~/.claude.json` の `mcpServers`、プロジェクトの `.mcp.json`、`~/.claude/settings.json` / `.claude/settings.json` | サーバー1つ = Asset 1つ。footprintTokens は **算出不能として 0 + meta.tokenNote = 'unknown'**（tool 定義はサーバー起動時のみ取得可能。偽精度を出さない） |
| claudemd | `~/.claude/CLAUDE.md`、`~/.claude/rules/*.md`、`<project>/CLAUDE.md` | footprint = full（常時ロード） |
| memory | `~/.claude/projects/*/memory/*.md`（MEMORY.md 含む） | MEMORY.md は footprint = full、個別メモリは footprint 0 / full = ファイル全体（recall 時のみロード） |
| commands | `~/.claude/commands/*.md`、`<project>/.claude/commands/*.md` | |
| agents | `~/.claude/agents/*.md`、`<project>/.claude/agents/*.md` | ディレクトリ不在環境あり（実機確認済み）→ スキップ動作必須 |

プロジェクト横断: v0.1 のスコープは **user スコープ + カレントディレクトリのプロジェクト**。
`--all-projects` は v0.2。

### 4.2 usage — Transcript 解析と Ledger（本品の心臓部）

**実機検証済みの transcript 構造**（2026-06-11、Claude Code 実データ 71ファイル/33,355行で確認）:

- 場所: `~/.claude/projects/<dir-slug>/<sessionId>.jsonl`
- 行は JSON。`type` フィールド: `assistant` / `user` / `system` / `progress` / `queue-operation` 等
- **`type === 'assistant'` の行のみ対象**。`message.content` が配列で、要素に `{ type: 'tool_use', name, input }` が含まれる
- 抽出ルール:
  - `name === 'Skill'` → `UsageEvent { kind: 'skill', ref: input.skill }`（`input.skill` 実在確認済み。`superpowers:writing-plans` のようなプラグイン名前空間込みの値が入る）
  - `name` が `mcp__` で始まる → `mcp__<server>__<tool>` を分解し `{ kind: 'mcp-tool', ref: server, tool }`（server 名に `__` が含まれるケースに備え、**最初の `mcp__` の後から最後の `__` まで**を server とする実装は不可。`name.slice(5)` を `__` で split し、`parts[0]` を server、残り join を tool とする。`plugin_context-mode_context-mode` のような server 名も1セグメントで来ることを確認済み）
  - `name === 'Agent'` または `name === 'Task'` → `{ kind: 'agent', ref: input.subagent_type ?? 'general-purpose' }`
- 各行の `timestamp`（ISO8601）、`sessionId`、`cwd` を UsageEvent に付与
- パース不能行・想定外構造は **黙ってスキップしカウントのみ**（透明性のため `--verbose` で表示）。クラッシュ厳禁

**Ledger（transcript 30日ローテーション対策。実機で最古 2026-05-12 を確認 = 保持約30日）**:

- `~/.curator/ledger.jsonl` に UsageEvent を append
- `~/.curator/state.json` に処理済みファイルを記録: `{ [filePath]: { mtimeMs, size, lineCount } }`
  - mtime と size が変わらないファイルはスキップ（増分処理）
  - 変わったファイルは記録済み lineCount 以降のみ読む（追記前提。縮んでいたら全再読）
- 重複防止: ledger 追記は state 更新と同一トランザクション的順序（ledger 書き込み成功後に state 保存）
- `curator usage --rebuild` で ledger を作り直し（state 破棄 → 全 transcript 再走査）

### 4.3 tokens — トークン見積もり

```
estimateTokens(text) = ceil(ascii文字数 / 3.7 + 非ascii文字数 / 1.8)
```
ヒューリスティックである旨を表示時に `~` 付きで明示。MCP server の footprint は算出しない（unknown 表示）。
偽精度は信頼を毀損する — unclog も同じ理由で `— tok` 表示を選んでいる。

### 4.4 policy — Policy Engine

`~/.curator/config.yaml`（なければデフォルト生成はせず内蔵デフォルトで動作）:

```yaml
policy:
  staleDays: 30        # 最終使用がこれより古い → stale
  unusedGraceDays: 14  # 使用記録ゼロでも、作成からこの日数は許容
  bloat:
    claudeMdTokens: 3000
    skillFullTokens: 8000
    memoryFileTokens: 2000
ignore:
  - "skill:daily-commit"   # asset id の glob
```

判定ルール（rules.ts、純関数）:

| type | 条件 | severity |
|---|---|---|
| `stale` | usage あり、最終使用 > staleDays | warn（>= 3×staleDays で high） |
| `unused` | usage 記録ゼロ かつ modifiedAt > unusedGraceDays 前 | warn |
| `bloated` | footprint/full が kind 別しきい値超 | warn |
| `zombie` | mcp-server: 定義の `command` 実行ファイルが PATH/絶対パスに存在しない | high |

注意: usage と asset の突合キーは skill 名 / server 名 / agent 名。プラグインスキルは
`plugin:skill` 形式で一致させる。**claude-md / memory は usage 判定対象外**
（ロードが暗黙的で transcript に現れないため。bloated 判定のみ適用）。誤って unused 扱いしない。

### 4.5 report

**`curator check`** — Finding 一覧。kind 別にグルーピング、severity 色分け、`--filter stale` 等、`--json`。

**`curator cost`** — ヘッドライン機能。出力例:

```
Context Health Report (2026-06-11)
══════════════════════════════════
起動時コンテキスト寄与（常時ロード分・推定）
  CLAUDE.md (user + project)   ~12.4K tokens
  rules/                        ~3.1K tokens
  skills frontmatter × 47       ~4.7K tokens
  MEMORY.md                     ~0.4K tokens
  MCP servers × 11              (unknown — tool定義は実測不能)
  ─────────────────────────────
  合計（推定可能分）            ~20.6K tokens

  うち stale/unused 資産の寄与:  ~7.2K tokens (35%)

  Context Health Score: 65/100
```

Score v0.1 定義: `100 - round(staleFootprintTokens / totalFootprintTokens * 100)`。
`~/.curator/history.jsonl` に実行ごとのサマリを append（時系列トラッキングの布石）。

### 4.6 CLI

```
curator scan   [--json]            # 台帳構築・表示（毎回フル再スキャン、キャッシュなし）
curator usage  [--days N] [--rebuild] [--json]   # ledger 更新 + 使用統計表示
curator check  [--filter <type>] [--json]        # scan + usage + policy 評価
curator cost   [--json]                          # Health Score レポート
```

`check` / `cost` は内部で scan + ledger 更新を実行（ユーザーがコマンドを覚える負担を減らす）。
終了コード: check で high が1件以上 → exit 1（CI 組み込み用）。

## 5. テスト方針

- `test/fixtures/fake-claude/` に合成 ~/.claude（skills 3個・うち1つ plugin、CLAUDE.md、mcp 設定2系統）
- `test/fixtures/transcripts/` に合成 JSONL（Skill / mcp__ / Agent / 壊れた行 / 想定外 type を含む）
- paths.ts は環境変数 `CURATOR_CLAUDE_DIR` / `CURATOR_HOME` で全パスを差し替え可能にし、テストはこれで fixtures に向ける
- 必須テスト: extract のツール名分解（`mcp__a__b__c` 含む）、ledger 増分処理（追記/不変/縮小）、policy 純関数、壊れた transcript 行でクラッシュしない

## 6. v0.2 以降（実装しない。設計上の考慮のみ）

- 承認制 apply（archive へ移動 + `curator restore`）/ 重複検出（説明文類似度）/ `--all-projects`
- スキルラッパー（`/curator` スキル。CLI を呼ぶ薄い層）/ Observability ダッシュボード統合
- memory 内容 lint（古い citation・case-specific entity 検出）

## 7. 実装上の絶対条件（監査チェック項目）

1. **~/.claude 配下への書き込みコードが存在しないこと**（fs write 系の宛先は ~/.curator のみ）
2. transcript パースは stream（readline）で行い、ファイル全文を文字列に載せない
3. 全 scanner / parser は対象不在・壊れたデータで例外を投げず空配列 + 警告カウント
4. 依存パッケージは package.json に記す前に必要性を吟味（目標: 実行時依存 3 個以下）
5. トークン数は常に `~` 付き推定表示。MCP は unknown と正直に出す
