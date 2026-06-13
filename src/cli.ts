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
import { buildProposals, describeProposal } from './apply/proposals.js';
import { archiveAsset } from './apply/archive.js';
import { listArchives, restoreArchive } from './apply/restore.js';
import { installSkill } from './apply/install-skill.js';
import { buildMcpDisableProposals, applyMcpDisable } from './apply/mcp-disable.js';
import { loadMcpMatrix, listKnownProjectDirs } from './usage/index.js';
import { buildMcpReport } from './report/mcp.js';
import { buildHistoryReport } from './report/history.js';
import { lintMemories } from './policy/memory-lint.js';
import type { Asset, AssetKind, FindingType, Proposal, UsageStats } from './types.js';

const FINDING_TYPES: FindingType[] = ['stale', 'unused', 'bloated', 'zombie', 'duplicate', 'lint'];

const program = new Command();

program
  .name('curator')
  .description('Claude context asset inventory and hygiene tool')
  .version('0.4.0');

// ─── scan ──────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Build and display asset inventory (full re-scan, no cache)')
  .option('--all-projects', 'Include project-scoped assets from all known projects')
  .option('--json', 'Output as JSON')
  .action(async (opts: { allProjects?: boolean; json?: boolean }) => {
    const paths = resolvePaths();
    const projectDirs = opts.allProjects ? await listKnownProjectDirs(paths) : undefined;
    const inventory = await buildInventory(paths, {
      allProjects: opts.allProjects,
      projectDirs,
    });

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
  .option('--filter <type>', 'Filter by finding type (stale|unused|bloated|zombie|duplicate)')
  .option('--all-projects', 'Include project-scoped assets from all known projects')
  .option('--json', 'Output as JSON')
  .action(async (opts: { filter?: string; allProjects?: boolean; json?: boolean }) => {
    if (opts.filter && !FINDING_TYPES.includes(opts.filter as FindingType)) {
      console.error(pc.red(`--filter must be one of: ${FINDING_TYPES.join(', ')}`));
      process.exit(2);
    }
    const { findings } = await runEvaluation(opts.allProjects);
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
  .option('--history', 'Show score history over time instead of a new report')
  .option('--limit <n>', 'Max history entries to show (default 30)')
  .option('--all-projects', 'Include project-scoped assets from all known projects')
  .option('--json', 'Output as JSON')
  .action(async (opts: {
    history?: boolean; limit?: string; allProjects?: boolean; json?: boolean;
  }) => {
    const paths = resolvePaths();
    if (opts.history) {
      const limit = opts.limit ? Number(opts.limit) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        console.error(pc.red('--limit must be a positive number'));
        process.exit(2);
      }
      const report = buildHistoryReport(paths.curatorHome, { limit, json: opts.json });
      if (opts.json) {
        process.stdout.write(JSON.stringify(report.json, null, 2) + '\n');
      } else {
        console.log(report.text);
      }
      return;
    }
    const { assets, findings } = await runEvaluation(opts.allProjects);
    const report = buildCostReport(assets, findings, {
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

// ─── apply ─────────────────────────────────────────────────────────────────
program
  .command('apply')
  .description('Archive assets flagged by check, with per-item approval')
  .option('--filter <type>', 'Only propose findings of this type (stale|unused|zombie|duplicate)')
  .option('--ids <ids>', 'Comma-separated asset ids to propose')
  .option('--dry-run', 'Show what would happen without writing anything')
  .option('--yes', 'Approve all proposals without prompting')
  .option('--json', 'Output result as JSON')
  .action(async (opts: {
    filter?: string; ids?: string; dryRun?: boolean; yes?: boolean; json?: boolean;
  }) => {
    if (opts.filter && !FINDING_TYPES.includes(opts.filter as FindingType)) {
      console.error(pc.red(`--filter must be one of: ${FINDING_TYPES.join(', ')}`));
      process.exit(2);
    }
    const paths = resolvePaths();
    const { findings } = await runEvaluation();
    const proposals = buildProposals(findings, {
      filter: opts.filter as FindingType | undefined,
      ids: opts.ids ? opts.ids.split(',').map((s) => s.trim()) : undefined,
    });

    if (proposals.length === 0) {
      console.log(pc.dim('アーカイブ提案はありません。'));
      return;
    }

    if (opts.dryRun) {
      console.log(pc.bold(`\nDry run — ${proposals.length} 件の提案（書き込みなし）\n`));
      for (const p of proposals) {
        console.log(`  ${pc.yellow(p.findingType.padEnd(9))} ${pc.green(p.assetId)}`);
        console.log(pc.dim(`    理由: ${p.reason}`));
        console.log(pc.dim(`    操作: ${describeProposal(p)}`));
      }
      return;
    }

    const approved: Proposal[] = [];
    if (opts.yes) {
      approved.push(...proposals);
    } else {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const p of proposals) {
          console.log(`\n${pc.yellow(p.findingType.padEnd(9))} ${pc.green(p.assetId)}`);
          console.log(pc.dim(`  理由: ${p.reason}`));
          console.log(pc.dim(`  操作: ${describeProposal(p)}`));
          const ans = (await rl.question('  アーカイブする? [y/n/q] ')).trim().toLowerCase();
          if (ans === 'q') break;
          if (ans === 'y') approved.push(p);
        }
      } finally {
        rl.close();
      }
    }

    let archived = 0;
    const errors: string[] = [];
    for (const p of approved) {
      try {
        const manifest = await archiveAsset(paths, p);
        archived++;
        if (!opts.json) {
          console.log(pc.green(`  ✓ archived: ${p.assetId} → ${manifest.archiveId}`));
        }
      } catch (e) {
        errors.push(`${p.assetId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary = {
      proposed: proposals.length,
      approved: approved.length,
      archived,
      skipped: proposals.length - approved.length,
      errors,
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    } else {
      console.log(
        `\n${pc.bold('Summary')}  archived: ${archived}  skipped: ${summary.skipped}` +
        (errors.length ? pc.red(`  errors: ${errors.length}`) : ''),
      );
      for (const err of errors) console.error(pc.red(`  ✗ ${err}`));
      console.log(pc.dim(`復元するには: curator restore <archiveId>`));
    }
    if (errors.length > 0) process.exit(1);
  });

// ─── restore ───────────────────────────────────────────────────────────────
program
  .command('restore')
  .description('List archived assets, or restore one by archiveId')
  .argument('[archiveId]', 'Archive id to restore (omit to list)')
  .option('--all', 'Include already-restored entries in the list')
  .option('--json', 'Output as JSON')
  .action(async (archiveId: string | undefined, opts: { all?: boolean; json?: boolean }) => {
    const paths = resolvePaths();
    if (!archiveId) {
      const archives = await listArchives(paths, { all: opts.all });
      if (opts.json) {
        process.stdout.write(JSON.stringify(archives, null, 2) + '\n');
        return;
      }
      if (archives.length === 0) {
        console.log(pc.dim('アーカイブはありません。'));
        return;
      }
      console.log(pc.bold('\nArchived assets'));
      for (const m of archives) {
        const restored = m.restoredAt ? pc.dim(` (restored ${m.restoredAt.slice(0, 10)})`) : '';
        console.log(
          `  ${pc.green(m.archiveId.padEnd(44))} ${pc.dim(m.kind.padEnd(11))}` +
          `${m.archivedAt.slice(0, 10)}${restored}`,
        );
        console.log(pc.dim(`    ${m.reason}`));
      }
      console.log(pc.dim(`\n復元するには: curator restore <archiveId>`));
      return;
    }
    try {
      await restoreArchive(paths, archiveId);
      console.log(pc.green(`✓ restored: ${archiveId}`));
    } catch (e) {
      console.error(pc.red(`✗ restore failed: ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    }
  });

// ─── mcp ───────────────────────────────────────────────────────────────────
program
  .command('mcp')
  .description('Per-project MCP server usage matrix and active-set suggestions')
  .option('--days <n>', 'Limit to last N days (default: all time)')
  .option('--all', 'Show all projects (default: top 8 by event count)')
  .option('--apply', 'Disable unused project-defined (.mcp.json) servers, with approval')
  .option('--dry-run', 'With --apply: show what would change without writing')
  .option('--yes', 'With --apply: approve all proposals without prompting')
  .option('--json', 'Output as JSON')
  .action(async (opts: {
    days?: string; all?: boolean; apply?: boolean;
    dryRun?: boolean; yes?: boolean; json?: boolean;
  }) => {
    const days = opts.days ? Number(opts.days) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
      console.error(pc.red('--days must be a positive number'));
      process.exit(2);
    }
    const paths = resolvePaths();
    await updateLedger(paths);
    const matrix = await loadMcpMatrix(paths, { days });

    if (opts.apply || opts.dryRun) {
      const projectDirs = await listKnownProjectDirs(paths);
      const proposals = await buildMcpDisableProposals(matrix, projectDirs);
      if (proposals.length === 0) {
        console.log(pc.dim('無効化候補はありません（.mcp.json 定義済みで未使用のサーバーなし）。'));
        return;
      }
      if (opts.dryRun) {
        console.log(pc.bold(`\nDry run — ${proposals.length} 件の無効化候補（書き込みなし）\n`));
        for (const p of proposals) {
          console.log(`  ${pc.green(p.serverName.padEnd(28))} ${pc.dim(p.projectDir)}`);
          console.log(pc.dim(`    理由: ${p.reason}`));
          console.log(pc.dim(`    操作: ${p.settingsPath} の disabledMcpjsonServers に追記`));
        }
        return;
      }
      const approved: typeof proposals = [];
      if (opts.yes) {
        approved.push(...proposals);
      } else {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          for (const p of proposals) {
            console.log(`\n${pc.green(p.serverName)} ${pc.dim(`@ ${p.projectDir}`)}`);
            console.log(pc.dim(`  理由: ${p.reason}`));
            console.log(pc.dim(`  操作: ${p.settingsPath} の disabledMcpjsonServers に追記`));
            const ans = (await rl.question('  無効化する? [y/n/q] ')).trim().toLowerCase();
            if (ans === 'q') break;
            if (ans === 'y') approved.push(p);
          }
        } finally {
          rl.close();
        }
      }
      let applied = 0;
      const errors: string[] = [];
      for (const p of approved) {
        try {
          await applyMcpDisable(paths, p);
          applied++;
          console.log(pc.green(`  ✓ disabled: ${p.serverName} @ ${p.projectDir}`));
        } catch (e) {
          errors.push(`${p.serverName} @ ${p.projectDir}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(
        `\n${pc.bold('Summary')}  disabled: ${applied}  skipped: ${proposals.length - approved.length}` +
        (errors.length ? pc.red(`  errors: ${errors.length}`) : ''),
      );
      for (const err of errors) console.error(pc.red(`  ✗ ${err}`));
      console.log(pc.dim('元に戻すには settings.json の disabledMcpjsonServers から該当名を削除（backup あり）'));
      if (errors.length > 0) process.exit(1);
      return;
    }

    const inventory = await buildInventory(paths);
    const report = buildMcpReport(matrix, inventory.assets, {
      all: opts.all,
      json: opts.json,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report.json, null, 2) + '\n');
    } else {
      console.log(report.text);
    }
  });

// ─── install-skill ─────────────────────────────────────────────────────────
program
  .command('install-skill')
  .description('Install the /curator skill wrapper into ~/.claude/skills/curator/')
  .option('--force', 'Overwrite an existing installation')
  .action(async (opts: { force?: boolean }) => {
    const paths = resolvePaths();
    try {
      const result = await installSkill(paths, { force: opts.force });
      console.log(pc.green(`✓ installed: ${result.installedTo}`));
      if (result.warning) console.log(pc.yellow(`  ⚠ ${result.warning}`));
    } catch (e) {
      console.error(pc.red(`✗ ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    }
  });

/** Shared pipeline: ledger update + scan + policy evaluation */
async function runEvaluation(allProjects = false): Promise<{ assets: Asset[]; findings: ReturnType<typeof evaluate> }> {
  const paths = resolvePaths();
  const config = loadConfig(paths.curatorHome);
  // ledger を先に更新 — all-projects のプロジェクト発見は ledger の cwd に依存する
  await updateLedger(paths);
  const projectDirs = allProjects ? await listKnownProjectDirs(paths) : undefined;
  const inventory = await buildInventory(paths, { allProjects, projectDirs });
  const stats = await loadUsageStats(paths);
  const findings = evaluate(inventory.assets, stats, config.policy, config.ignore);
  // memory 内容 lint は I/O を伴うため engine（純関数）の外で結合（DESIGN.md §10.3）
  const lintFindings = await lintMemories(inventory.assets, config.policy);
  return { assets: inventory.assets, findings: [...findings, ...lintFindings] };
}

await program.parseAsync(process.argv);

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
