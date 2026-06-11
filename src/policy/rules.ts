// rules.ts — pure functions for each finding type (DESIGN.md §4.4)
// All functions are side-effect-free and accept `now` as a parameter for testability.
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Asset, Finding, UsageStats } from '../types.js';
import type { PolicyConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Days between two dates (a - b, floored to 0 if negative) */
function daysSince(a: Date, b: Date): number {
  return Math.max(0, (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Simple glob match — supports only `*` as a wildcard (matches any chars
 * including none, does NOT cross `/`).  The spec says "asset id の glob、`*`
 * のみサポートの簡易 glob で可" so this intentional subset is enough.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  // Escape special regex chars except *
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const reStr = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${reStr}$`).test(value);
}

/** Return true if asset.id matches any ignore pattern */
export function isIgnored(id: string, ignoreList: string[]): boolean {
  return ignoreList.some((pattern) => matchesGlob(pattern, id));
}

/**
 * Locate an executable on PATH.
 * Returns the resolved absolute path if found, undefined otherwise.
 * Uses only node:fs and node:path as required.
 */
function findOnPath(command: string): string | undefined {
  const pathEnv = process.env['PATH'] ?? '';
  const dirs = pathEnv.split(':');
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Individual rule functions
// ---------------------------------------------------------------------------

/**
 * stale: usage exists, but last use is older than `staleDays`.
 * Not applicable to claude-md or memory kinds.
 */
export function checkStale(
  asset: Asset,
  stats: UsageStats | undefined,
  policy: PolicyConfig,
  now: Date,
): Finding | null {
  // claude-md / memory are exempt from stale/unused checks
  if (asset.kind === 'claude-md' || asset.kind === 'memory') return null;

  // No usage record → handled by checkUnused, not here
  if (!stats || !stats.lastUsed) return null;

  const lastUsed = new Date(stats.lastUsed);
  const age = daysSince(now, lastUsed);

  if (age <= policy.staleDays) return null;

  const severity: Finding['severity'] = age >= policy.staleDays * 3 ? 'high' : 'warn';
  const ageDays = Math.floor(age);

  return {
    asset,
    type: 'stale',
    severity,
    reason: `最終使用 ${stats.lastUsed.slice(0, 10)}（${ageDays}日前）/ しきい値 ${policy.staleDays}日`,
    suggestion: `"${asset.name}" は ${ageDays}日間使われていません。不要であれば削除を検討してください。`,
  };
}

/**
 * unused: no usage record AND modifiedAt is older than `unusedGraceDays`.
 * Not applicable to claude-md or memory kinds.
 */
export function checkUnused(
  asset: Asset,
  stats: UsageStats | undefined,
  policy: PolicyConfig,
  now: Date,
): Finding | null {
  // claude-md / memory are exempt
  if (asset.kind === 'claude-md' || asset.kind === 'memory') return null;

  // Has usage → not unused
  if (stats && stats.count > 0) return null;

  const modifiedAt = new Date(asset.modifiedAt);
  const age = daysSince(now, modifiedAt);

  // Within grace period → no finding
  if (age <= policy.unusedGraceDays) return null;

  const ageDays = Math.floor(age);

  return {
    asset,
    type: 'unused',
    severity: 'warn',
    reason: `使用記録なし、最終更新 ${asset.modifiedAt.slice(0, 10)}（${ageDays}日前）/ 猶予期間 ${policy.unusedGraceDays}日`,
    suggestion: `"${asset.name}" は一度も使用された記録がありません。不要であれば削除を検討してください。`,
  };
}

/**
 * bloated: footprint or full token count exceeds kind-specific threshold.
 * Applies to all kinds (including claude-md and memory).
 */
export function checkBloated(
  asset: Asset,
  _stats: UsageStats | undefined,
  policy: PolicyConfig,
  _now: Date,
): Finding | null {
  let threshold: number | undefined;
  let tokenValue: number;
  let tokenLabel: string;

  switch (asset.kind) {
    case 'claude-md':
      threshold = policy.bloat.claudeMdTokens;
      tokenValue = asset.footprintTokens; // always loaded → footprint
      tokenLabel = 'footprint';
      break;
    case 'memory':
      threshold = policy.bloat.memoryFileTokens;
      tokenValue = asset.fullTokens;
      tokenLabel = 'full';
      break;
    case 'skill':
      threshold = policy.bloat.skillFullTokens;
      tokenValue = asset.fullTokens;
      tokenLabel = 'full';
      break;
    default:
      // command / agent / mcp-server: no bloat threshold defined in §4.4
      return null;
  }

  if (threshold === undefined || tokenValue <= threshold) return null;

  return {
    asset,
    type: 'bloated',
    severity: 'warn',
    reason: `${tokenLabel} トークン数 ${tokenValue} がしきい値 ${threshold} を超過`,
    suggestion: `"${asset.name}" は大きすぎます（${tokenValue} tokens）。分割や削減を検討してください。`,
  };
}

/**
 * zombie: mcp-server whose `command` executable cannot be found.
 * Only applies to mcp-server kind.
 * Absolute path → existsSync; command name → PATH search.
 */
export function checkZombie(
  asset: Asset,
  _stats: UsageStats | undefined,
  _policy: PolicyConfig,
  _now: Date,
): Finding | null {
  if (asset.kind !== 'mcp-server') return null;

  const command = asset.meta?.['command'];
  if (typeof command !== 'string' || command.trim() === '') return null;

  const cmd = command.trim();
  let found: boolean;

  if (isAbsolute(cmd)) {
    found = existsSync(cmd);
  } else {
    // Command name (possibly with args) — only test the first token
    const executable = cmd.split(/\s+/)[0];
    found = findOnPath(executable ?? cmd) !== undefined;
  }

  if (found) return null;

  return {
    asset,
    type: 'zombie',
    severity: 'high',
    reason: `command "${cmd}" が PATH / 絶対パスに存在しません`,
    suggestion: `"${asset.name}" の MCP サーバーが見つかりません。設定を確認するか、サーバーをインストールしてください。`,
  };
}
