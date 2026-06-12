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
| 問題を一覧して / 使ってないものは? | `curator check --json` |
| 使用統計を見せて | `curator usage --json`（`--days N` で期間指定） |
| 推移を見せて | `curator cost --history` |
| プロジェクト別の MCP 使用状況 | `curator mcp` |
| 片付けて / アーカイブして | 下記「apply の手順」 |
| 戻して | `curator restore`（一覧）→ `curator restore <archiveId>` |

## 運用ルール（2つだけ）

1. **`--json` で取得し、要点のみ要約して報告する**。生 JSON を会話に貼らない
2. **apply は必ず2段階**: まず `curator apply --dry-run` の結果を提示し、
   ユーザーが対象を承認した後に `curator apply --ids <承認されたid> --yes` を実行する。
   承認なしに `--yes` を使わない
