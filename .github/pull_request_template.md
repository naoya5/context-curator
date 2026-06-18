## 変更内容
何を・なぜ変えたか。

## 種別
- [ ] feat（新機能）
- [ ] fix（バグ修正）
- [ ] docs
- [ ] refactor / chore / test

## チェックリスト
- [ ] `npm run typecheck` が通る
- [ ] `npm test` が通る（新機能・修正にはテストを追加）
- [ ] `npm run build` が通る
- [ ] 設計の不変条件（CONTRIBUTING.md）を守っている
  - [ ] 分析系は read-only / 書き込みは承認済み操作のみ
  - [ ] 削除しない（移動のみ）
  - [ ] ダッシュボード変更時：自己完結・全エスケープ・純関数を維持
