# 設定リファレンス

context-curator は `~/.curator/config.yaml` を読み込む。
ファイルが無い・パースに失敗した場合は内蔵デフォルトで動作する（エラーにはしない）。
一部のキーだけ書いた場合、残りはデフォルトで補完される（deep merge）。

コピー用テンプレート: [config.example.yaml](../config.example.yaml)

---

## `policy`

検出ルールのしきい値。

### `policy.staleDays`

- 型: number（日数） / デフォルト: `30`
- **使用記録がある**資産で、最終使用日がこの日数より古いと `stale` と判定する
- 最終使用が `3 × staleDays` より古い場合は severity が `high` に上がる
- 対象 kind: skill / mcp-server / agent（使用統計が取れるもの）

### `policy.unusedGraceDays`

- 型: number（日数） / デフォルト: `14`
- **使用記録が一度もない**資産で、ファイルの最終更新からこの日数を超えると `unused` と判定する
- 作りたての資産を即座に「未使用」と誤検出しないための猶予期間
- 対象 kind: skill / mcp-server / agent

### `policy.duplicateThreshold`

- 型: number（0.0〜1.0） / デフォルト: `0.65`
- スキル重複検出の Jaccard 類似度しきい値
- 比較対象は `name + description`。ASCII 単語 + CJK 文字 bigram の混合集合で類似度を計算（日本語対応）
- ペアが成立すると、使用回数が少ない方（同数なら更新日が古い方）に `duplicate` finding が付く
- 高くすると「ほぼ完全一致」のみ検出、低くすると緩く検出

### `policy.bloat`

肥大（`bloated`）と判定するトークン数のしきい値。推定トークンが超えると finding が付く。

| キー | デフォルト | 対象 |
|---|---|---|
| `claudeMdTokens` | `3000` | CLAUDE.md / rules/*.md |
| `skillFullTokens` | `8000` | スキル全文（frontmatter + 本文 + 付随） |
| `memoryFileTokens` | `2000` | 個別 memory ファイル |

> bloated は archive 提案の対象外。分割・削減はユーザーの編集作業なので、検出のみ行う。

### `policy.memoryLint`

memory ファイルの内容 lint（静的解析）の設定。検出結果は `check` の `--filter lint` で絞れる。

| キー | デフォルト | 説明 |
|---|---|---|
| `oldDateDays` | `180` | 本文中の最新 ISO 日付がこれより古いと `[old-date]`。日付が1つも無いファイルは対象外 |
| `duplicateThreshold` | `0.7` | 同一ディレクトリ内 memory 本文の近似重複（`[near-duplicate]`）の Jaccard しきい値 |

memory lint の4ルール:

| タグ | 条件 | severity |
|---|---|---|
| `[old-date]` | 本文の最新日付が `oldDateDays` より過去 | info |
| `[broken-link]` | `[[name]]` の参照先が同ディレクトリに不在 | warn |
| `[index-mismatch]` | MEMORY.md のリンク切れ、または index 未参照の .md がある | warn |
| `[near-duplicate]` | 同一ディレクトリ内 memory 本文の類似度が `duplicateThreshold` 以上 | info |

> **lint の限界**: 静的解析のため、意味的な矛盾や事実の正確性は検出できない。
> 内容レビューは `/curator` スキル経由（check 結果を Claude に読ませる運用）に委ねる。
> lint は archive 提案の対象外（修正すべきは内容であって退避ではないため）。

---

## `ignore`

- 型: string の配列 / デフォルト: `[]`
- 検出から除外する asset id のリスト。`*` のみのワイルドカードに対応
- asset id の形式は `<kind>:<name>`

```yaml
ignore:
  - "skill:daily-commit"   # 特定スキルを除外
  - "command:*"            # 全コマンドを除外
  - "mcp-server:voisona"   # 特定 MCP サーバーを除外
```

asset id は `curator scan --json` の各 asset の `id` フィールドで確認できる。

---

## 設定が効く範囲

| コマンド | 参照する設定 |
|---|---|
| `scan` | なし（台帳化のみ） |
| `usage` | なし |
| `check` | `policy` 全体 + `ignore` + `memoryLint` |
| `cost` | `policy`（stale/unused の footprint 算入）+ `ignore` |
| `apply` | `check` と同じ評価を経由 |
| `mcp` | なし（使用統計のみ） |
