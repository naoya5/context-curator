#!/usr/bin/env node
// cli.ts — CLI entry point using commander (DESIGN.md §4.6)
import { Command } from 'commander';
import pc from 'picocolors';
import { resolvePaths } from './paths.js';
import { buildInventory } from './scan/inventory.js';
import type { Asset, AssetKind } from './types.js';

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
  .action(() => {
    console.log('not implemented in this build');
    process.exit(0);
  });

// ─── check ─────────────────────────────────────────────────────────────────
program
  .command('check')
  .description('Scan + usage + policy evaluation, output findings')
  .option('--filter <type>', 'Filter by finding type (stale|unused|bloated|zombie)')
  .option('--json', 'Output as JSON')
  .action(() => {
    console.log('not implemented in this build');
    process.exit(0);
  });

// ─── cost ──────────────────────────────────────────────────────────────────
program
  .command('cost')
  .description('Context health score report')
  .option('--json', 'Output as JSON')
  .action(() => {
    console.log('not implemented in this build');
    process.exit(0);
  });

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
