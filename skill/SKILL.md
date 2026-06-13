---
name: curator
description: >-
  Claude Code環境のコンテキスト資産（skills/MCP/CLAUDE.md/memory）の健全性チェック・
  使用統計・アーカイブ提案。トリガー: 「コンテキスト掃除」「スキル整理」「MCP整理」
  「使ってないスキル」「コンテキスト診断」「curator」。
---

# curator

`curator` CLI の薄いラッパー。分析はすべて CLI が行う。

## コマンド対応

| ユーザーの意図 | 実行 |
|---|---|
| 健全性を診断して | `curator cost --json` |
| 問題を一覧して / 使ってないものは? | `curator check --json`（`--filter` で stale\|unused\|bloated\|zombie\|duplicate\|lint） |
| 全プロジェクト横断で見て | 上記に `--all-projects` を付与 |
| 使用統計を見せて | `curator usage --json`（`--days N` で期間指定） |
| 推移を見せて | `curator cost --history` |
| memory の問題を見て | `curator check --filter lint --json` |
| プロジェクト別の MCP 使用状況 | `curator mcp --json` |
| 使ってない MCP を整理して | 下記「mcp --apply の手順」 |
| 片付けて / アーカイブして | 下記「apply の手順」 |
| 戻して | `curator restore`（一覧）→ `curator restore <archiveId>` |
| スキルを入れて | `curator install-skill`（`--force` で上書き） |

## 運用ルール（3つだけ）

1. **`--json` で取得し、要点のみ要約して報告する**。生 JSON を会話に貼らない
2. **apply は必ず2段階**: まず `curator apply --dry-run` の結果を提示し、
   ユーザーが対象を承認した後に `curator apply --ids <承認されたid> --yes` を実行する。
   承認なしに `--yes` を使わない
3. **mcp --apply も同じ2段階**: `curator mcp --dry-run` で候補を提示 →
   ユーザー承認後に `curator mcp --apply`（対話）か `--apply --yes`（一括）を実行する
