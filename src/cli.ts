#!/usr/bin/env node
// cli.ts — CLI entry point using commander (DESIGN.md §4.6)
import { Command } from 'commander';
import pc from 'picocolors';
import { resolvePaths } from './paths.js';
import { buildInventory } from './scan/inventory.js';
import { loadConfig } from './config.js';
import { updateLedger, loadUsageStats, clearLedger } from './usage/index.js';
import { evaluate } from './policy/engine.js';
import { buildCheckReport } from './report/check.js';
import { buildCostReport, appendHistory } from './report/cost.js';
import type { Asset, AssetKind, FindingType, UsageStats } from './types.js';

const FINDING_TYPES: FindingType[] = ['stale', 'unused', 'bloated', 'zombie'];

const program = new Command();

program
  .name('curator')
  .description('Claude context asset inventory and hygiene tool')
  .version('0.1.0');

// ─── scan ──────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Build and display asset inventory (full re-scan, no cache)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const paths = resolvePaths();
    const inventory = await buildInventory(paths);

    if (opts.json) {
      process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
      return;
    }

    // Human-readable table output
    const { assets, scannedAt, warnings } = inventory;

    console.log(pc.bold('\nContext Curator — Asset Inventory'));
    console.log(pc.dim(`Scanned at: ${scannedAt}`));
    console.log(pc.dim(`Project: ${paths.projectDir}`));
    console.log('');

    const kindOrder: AssetKind[] = ['skill', 'mcp-server', 'claude-md', 'memory', 'command', 'agent'];
    const grouped = new Map<AssetKind, Asset[]>();
    for (const kind of kindOrder) grouped.set(kind, []);
    for (const asset of assets) {
      const list = grouped.get(asset.kind);
      if (list) list.push(asset);
    }

    let total = 0;
    for (const kind of kindOrder) {
      const list = grouped.get(kind) ?? [];
      if (list.length === 0) continue;

      const kindLabel = kindColor(kind);
      console.log(pc.bold(`${kindLabel} (${list.length})`));
      for (const a of list) {
        const footprint = a.meta?.['tokenNote'] === 'unknown'
          ? pc.dim('(unknown)')
          : pc.cyan(`~${a.footprintTokens} tok`);
        const full = pc.dim(`/ ~${a.fullTokens} full`);
        const scope = pc.dim(`[${a.scope}]`);
        console.log(`  ${pc.green(a.name.padEnd(40))} ${footprint} ${full} ${scope}`);
      }
      console.log('');
      total += list.length;
    }

    // Summary
    const totalFootprint = assets
      .filter((a) => a.meta?.['tokenNote'] !== 'unknown')
      .reduce((sum, a) => sum + a.footprintTokens, 0);
    const mcpCount = (grouped.get('mcp-server') ?? []).length;

    console.log(pc.bold('Summary'));
    console.log(`  Total assets : ${total}`);
    console.log(`  Startup footprint (est.) : ~${totalFootprint} tokens`);
    if (mcpCount > 0) {
      console.log(`  MCP servers  : ${mcpCount} (token footprint unknown)`);
    }
    if (warnings.length > 0) {
      console.log('');
      console.log(pc.yellow(`  Warnings (${warnings.length}):`));
      for (const w of warnings) {
        console.log(pc.yellow(`    ⚠ ${w}`));
      }
    }
    console.log('');
  });

// ─── usage ─────────────────────────────────────────────────────────────────
program
  .command('usage')
  .description('Show usage statistics from transcript ledger')
  .option('--days <n>', 'Limit to last N days')
  .option('--rebuild', 'Rebuild ledger from scratch')
  .option('--json', 'Output as JSON')
  .action(async (opts: { days?: string; rebuild?: boolean; json?: boolean }) => {
    const paths = resolvePaths();
    if (opts.rebuild) await clearLedger(paths);
    const result = await updateLedger(paths);
    const days = opts.days ? Number(opts.days) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
      console.error(pc.red('--days must be a positive number'));
      process.exit(2);
    }
    const stats = await loadUsageStats(paths, { days });

    if (opts.json) {
      process.stdout.write(JSON.stringify({ ledger: result, stats }, null, 2) + '\n');
      return;
    }

    console.log(pc.bold('\nContext Curator — Usage Statistics'));
    console.log(pc.dim(
      `Ledger updated: +${result.newEvents} events ` +
      `(${result.scannedFiles} transcripts scanned, ${result.skippedFiles} unchanged)`,
    ));
    if (days) console.log(pc.dim(`Window: last ${days} days`));
    console.log('');

    const byKind = new Map<UsageStats['kind'], UsageStats[]>();
    for (const s of stats) {
      const list = byKind.get(s.kind) ?? [];
      list.push(s);
      byKind.set(s.kind, list);
    }
    const kindLabels: Record<UsageStats['kind'], string> = {
      'skill': 'Skills',
      'mcp-tool': 'MCP Servers',
      'agent': 'Agents',
    };
    for (const [kind, list] of byKind) {
      list.sort((a, b) => b.count - a.count);
      console.log(pc.bold(`${kindLabels[kind]} (${list.length})`));
      for (const s of list) {
        const last = s.lastUsed ? s.lastUsed.slice(0, 10) : 'never';
        console.log(
          `  ${pc.green(s.ref.padEnd(44))} ${String(s.count).padStart(5)}×  ` +
          pc.dim(`last: ${last}  projects: ${s.projects.length}`),
        );
      }
      console.log('');
    }
    if (stats.length === 0) {
      console.log(pc.dim('  (no usage events recorded yet)'));
    }
  });

// ─── check ─────────────────────────────────────────────────────────────────
program
  .command('check')
  .description('Scan + usage + policy evaluation, output findings')
  .option('--filter <type>', 'Filter by finding type (stale|unused|bloated|zombie)')
  .option('--json', 'Output as JSON')
  .action(async (opts: { filter?: string; json?: boolean }) => {
    if (opts.filter && !FINDING_TYPES.includes(opts.filter as FindingType)) {
      console.error(pc.red(`--filter must be one of: ${FINDING_TYPES.join(', ')}`));
      process.exit(2);
    }
    const findings = await runEvaluation();
    const report = buildCheckReport(findings, {
      filter: opts.filter as FindingType | undefined,
      json: opts.json,
    });
    console.log(report.text);
    process.exit(report.exitCode);
  });

// ─── cost ──────────────────────────────────────────────────────────────────
program
  .command('cost')
  .description('Context health score report')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const paths = resolvePaths();
    const config = loadConfig(paths.curatorHome);
    const inventory = await buildInventory(paths);
    await updateLedger(paths);
    const stats = await loadUsageStats(paths);
    const findings = evaluate(inventory.assets, stats, config.policy, config.ignore);
    const report = buildCostReport(inventory.assets, findings, {
      json: opts.json,
      curatorHome: paths.curatorHome,
    });
    const j = report.json as {
      date: string;
      totalFootprintTokens: number;
      staleFootprintTokens: number;
      findingCount: number;
    };
    appendHistory(paths.curatorHome, {
      date: j.date,
      score: report.score,
      totalTokens: j.totalFootprintTokens,
      staleTokens: j.staleFootprintTokens,
      findingCount: j.findingCount,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report.json, null, 2) + '\n');
    } else {
      console.log(report.text);
    }
  });

/** Shared pipeline for check: scan + ledger update + policy evaluation */
async function runEvaluation() {
  const paths = resolvePaths();
  const config = loadConfig(paths.curatorHome);
  const inventory = await buildInventory(paths);
  await updateLedger(paths);
  const stats = await loadUsageStats(paths);
  return evaluate(inventory.assets, stats, config.policy, config.ignore);
}

program.parse(process.argv);

// ─── helpers ───────────────────────────────────────────────────────────────
function kindColor(kind: AssetKind): string {
  switch (kind) {
    case 'skill':     return pc.magenta('Skills');
    case 'mcp-server': return pc.blue('MCP Servers');
    case 'claude-md': return pc.yellow('CLAUDE.md / Rules');
    case 'memory':    return pc.cyan('Memory');
    case 'command':   return pc.white('Commands');
    case 'agent':     return pc.green('Agents');
  }
}
