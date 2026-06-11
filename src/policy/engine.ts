// engine.ts — Policy Engine: evaluate assets against policy (DESIGN.md §4.4)
import type { Asset, Finding, UsageStats } from '../types.js';
import type { PolicyConfig } from '../config.js';
import { isIgnored, checkStale, checkUnused, checkBloated, checkZombie } from './rules.js';

// ---------------------------------------------------------------------------
// kind mapping: asset kind  ←→  UsageStats kind
// ---------------------------------------------------------------------------
// DESIGN.md §4.4: "usage と asset の突合キーは skill 名 / server 名 / agent 名"
// kind mapping: skill↔skill, mcp-server↔mcp-tool, agent↔agent
type StatsKind = UsageStats['kind'];

function assetKindToStatsKind(assetKind: Asset['kind']): StatsKind | null {
  switch (assetKind) {
    case 'skill': return 'skill';
    case 'mcp-server': return 'mcp-tool';
    case 'agent': return 'agent';
    default: return null; // claude-md, memory, command — no usage tracking
  }
}

/**
 * Build an index from (kind, ref) → UsageStats for O(1) lookup.
 */
function buildStatsIndex(stats: UsageStats[]): Map<string, UsageStats> {
  const map = new Map<string, UsageStats>();
  for (const s of stats) {
    map.set(`${s.kind}:${s.ref}`, s);
  }
  return map;
}

/**
 * Evaluate all assets against the policy and return a flat Finding[].
 *
 * @param assets  - from Inventory
 * @param stats   - from UsageLedger (may be empty)
 * @param policy  - from CuratorConfig.policy
 * @param ignore  - asset id patterns to skip (from CuratorConfig.ignore)
 * @param now     - injectable for tests (defaults to new Date())
 */
export function evaluate(
  assets: Asset[],
  stats: UsageStats[],
  policy: PolicyConfig,
  ignore: string[] = [],
  now: Date = new Date(),
): Finding[] {
  const statsIndex = buildStatsIndex(stats);
  const findings: Finding[] = [];

  for (const asset of assets) {
    // Skip ignored assets
    if (isIgnored(asset.id, ignore)) continue;

    // Look up usage stats for this asset
    const mappedKind = assetKindToStatsKind(asset.kind);
    const assetStats = mappedKind
      ? statsIndex.get(`${mappedKind}:${asset.name}`)
      : undefined;

    // Run all rules; collect non-null findings
    const rules = [checkStale, checkUnused, checkBloated, checkZombie];
    for (const rule of rules) {
      const finding = rule(asset, assetStats, policy, now);
      if (finding) findings.push(finding);
    }
  }

  return findings;
}
