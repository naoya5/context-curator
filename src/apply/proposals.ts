// proposals.ts — Finding[] から承認制 archive の提案を構築する（DESIGN.md §8.3）
// pure 関数。対話・I/O は cli.ts 側が担う。
import { basename, dirname } from 'node:path';
import type { Asset, AssetKind, Finding, FindingType, Proposal } from '../types.js';

/**
 * archive 時に実際に移動されるパス（DESIGN.md §8.2）。
 * skill は SKILL.md 単体ではなくスキルディレクトリ丸ごと —
 * references/ や scripts/ を孤児にしないため。
 * archive.ts と表示系の両方がこの1つの定義を使うこと（乖離防止）。
 */
export function archiveSourcePath(asset: Asset): string {
  if (asset.kind === 'skill' && basename(asset.path) === 'SKILL.md') {
    return dirname(asset.path);
  }
  return asset.path;
}

/** archive 可能な kind（claude-md は対象外、DESIGN.md §8.2） */
const ARCHIVABLE_KINDS: ReadonlySet<AssetKind> = new Set([
  'skill', 'command', 'agent', 'memory', 'mcp-server',
]);

/** 提案対象になる finding 種別（bloated は編集作業なので除外、§8.3） */
const PROPOSAL_TYPES: ReadonlySet<FindingType> = new Set([
  'stale', 'unused', 'zombie', 'duplicate',
]);

export interface BuildProposalsOptions {
  /** この finding type のみ提案する */
  filter?: FindingType;
  /** この asset id のみ提案する */
  ids?: string[];
}

/**
 * Finding[] → Proposal[]。
 * 同一 asset に複数の finding が付く場合は最初の1件のみ採用（assetId で dedupe）。
 */
export function buildProposals(
  findings: Finding[],
  opts: BuildProposalsOptions = {},
): Proposal[] {
  const idFilter = opts.ids ? new Set(opts.ids) : null;
  const seen = new Set<string>();
  const proposals: Proposal[] = [];

  for (const f of findings) {
    if (!PROPOSAL_TYPES.has(f.type)) continue;
    if (!ARCHIVABLE_KINDS.has(f.asset.kind)) continue;
    // plugin 内部のファイルを動かすとプラグインが壊れる。提案しない
    // （プラグインごと無効化するのが正しい対処であり、それはユーザーの操作領域）
    if (f.asset.scope === 'plugin') continue;
    if (opts.filter && f.type !== opts.filter) continue;
    if (idFilter && !idFilter.has(f.asset.id)) continue;
    if (seen.has(f.asset.id)) continue;
    seen.add(f.asset.id);
    proposals.push({
      assetId: f.asset.id,
      asset: f.asset,
      action: 'archive',
      findingType: f.type,
      reason: f.reason,
    });
  }
  return proposals;
}

/** dry-run / 対話表示用: この提案が実行されたら何が起きるかの1行説明 */
export function describeProposal(p: Proposal): string {
  if (p.asset.kind === 'mcp-server') {
    return `mcpServers["${p.asset.name}"] を ${p.asset.path} から除去（backup 作成、manifest に保存）`;
  }
  return `${archiveSourcePath(p.asset)} → ~/.curator/archive/ へ移動`;
}
