// memory-lint.ts — Memory file static lint rules (DESIGN.md §10.3)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Asset, Finding } from '../types.js';
import type { PolicyConfig } from '../config.js';
import { normalizeText, tokenize, jaccard } from './duplicates.js';

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no frontmatter block is present or it cannot be parsed.
 * We use a minimal line-by-line parser to avoid adding dependencies.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.split('\n');
  if (lines[0]?.trimEnd() !== '---') return null;

  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimEnd() === '---') break;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Strip YAML frontmatter from markdown content, returning the body only.
 */
function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trimEnd() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '---') {
      return lines.slice(i + 1).join('\n');
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

/** Extract all ISO 8601 date strings (YYYY-MM-DD) from a text body. */
function extractIsoDates(body: string): Date[] {
  const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const dates: Date[] = [];
  let m: RegExpExecArray | null;
  while ((m = ISO_DATE_RE.exec(body)) !== null) {
    const d = new Date(m[1]!);
    if (!isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

/** Extract Obsidian-style wikilinks [[name]] from content. Returns the inner names. */
function extractWikilinks(content: string): string[] {
  const WIKI_RE = /\[\[([^\]]+)\]\]/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(content)) !== null) {
    // Support [[name|alias]] — use only the name part
    const name = m[1]!.split('|')[0]!.trim();
    if (name) names.push(name);
  }
  return names;
}

/** Extract (file.md) link targets from MEMORY.md content. */
function extractMemoryMdLinks(content: string): string[] {
  const LINK_RE = /\(([^)]+\.md)\)/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(content)) !== null) {
    links.push(m[1]!.trim());
  }
  return links;
}

// ---------------------------------------------------------------------------
// Per-directory context builder
// ---------------------------------------------------------------------------

interface DirContext {
  /** Absolute directory path */
  dir: string;
  /** All .md filenames in the directory */
  mdFiles: string[];
  /** Map: filename (without extension) → frontmatter name field (if any) */
  nameBySlug: Map<string, string>;
  /** Content of each file (keyed by filename), skipped files absent */
  contents: Map<string, string>;
}

function buildDirContext(assets: Asset[]): Map<string, DirContext> {
  const byDir = new Map<string, Asset[]>();
  for (const asset of assets) {
    if (asset.kind !== 'memory') continue;
    const dir = dirname(asset.path);
    const arr = byDir.get(dir) ?? [];
    arr.push(asset);
    byDir.set(dir, arr);
  }

  const result = new Map<string, DirContext>();

  for (const [dir, dirAssets] of byDir) {
    // List all .md files in the directory from the FS
    let mdFiles: string[];
    try {
      mdFiles = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      // Directory unreadable — use asset paths only
      mdFiles = dirAssets.map((a) => basename(a.path));
    }

    const nameBySlug = new Map<string, string>();
    const contents = new Map<string, string>();

    for (const filename of mdFiles) {
      const filePath = join(dir, filename);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue; // unreadable → skip
      }
      contents.set(filename, content);

      // Parse frontmatter for the 'name' field
      try {
        const fm = parseFrontmatter(content);
        if (fm?.['name']) {
          nameBySlug.set(basename(filename, '.md'), fm['name']);
        }
      } catch {
        // Broken frontmatter is non-fatal
      }
    }

    result.set(dir, { dir, mdFiles, nameBySlug, contents });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rule: [old-date]
// ---------------------------------------------------------------------------

function lintOldDate(
  asset: Asset,
  content: string,
  policy: PolicyConfig,
  now: Date,
): Finding | null {
  const body = stripFrontmatter(content);
  const dates = extractIsoDates(body);
  if (dates.length === 0) return null; // 日付が1つも無いファイルは対象外

  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  const diffDays = (now.getTime() - maxDate.getTime()) / (1000 * 60 * 60 * 24);

  if (diffDays <= policy.memoryLint.oldDateDays) return null;

  const daysAgo = Math.floor(diffDays);
  return {
    asset,
    type: 'lint',
    severity: 'info',
    reason: `[old-date] 本文の最新日付 ${maxDate.toISOString().slice(0, 10)} は ${daysAgo} 日前（閾値 ${policy.memoryLint.oldDateDays} 日）`,
    suggestion: `記憶の内容を最新状態に更新するか、不要であれば削除してください。`,
  };
}

// ---------------------------------------------------------------------------
// Rule: [broken-link]
// ---------------------------------------------------------------------------

function lintBrokenLinks(
  asset: Asset,
  content: string,
  ctx: DirContext,
): Finding[] {
  const links = extractWikilinks(content);
  const findings: Finding[] = [];

  for (const linkName of links) {
    const slug = linkName.endsWith('.md') ? linkName.slice(0, -3) : linkName;

    // Check: filename without extension exists?
    const filenameMatch = ctx.mdFiles.some((f) => basename(f, '.md') === slug);
    if (filenameMatch) continue;

    // Check: frontmatter name field matches?
    const nameMatch = Array.from(ctx.nameBySlug.values()).includes(linkName);
    if (nameMatch) continue;

    findings.push({
      asset,
      type: 'lint',
      severity: 'warn',
      reason: `[broken-link] [[${linkName}]] の参照先が同ディレクトリに存在しません`,
      suggestion: `[[${linkName}]] が指すファイルを作成するか、リンクを修正・削除してください。`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule: [index-mismatch]
// ---------------------------------------------------------------------------

function lintIndexMismatch(
  memoryMdAsset: Asset,
  content: string,
  ctx: DirContext,
): Finding[] {
  const findings: Finding[] = [];
  const linkedFiles = extractMemoryMdLinks(content);

  // 1. Broken (file.md) links in MEMORY.md
  for (const linked of linkedFiles) {
    if (!ctx.mdFiles.includes(linked)) {
      findings.push({
        asset: memoryMdAsset,
        type: 'lint',
        severity: 'warn',
        reason: `[index-mismatch] MEMORY.md のリンク (${linked}) が存在しません`,
        suggestion: `(${linked}) を作成するか、MEMORY.md のリンクを修正・削除してください。`,
      });
    }
  }

  // 2. .md files in directory that are never referenced by MEMORY.md
  const linkedSet = new Set(linkedFiles);
  for (const mdFile of ctx.mdFiles) {
    if (mdFile === 'MEMORY.md') continue; // MEMORY.md itself is excluded
    if (!linkedSet.has(mdFile)) {
      findings.push({
        asset: memoryMdAsset,
        type: 'lint',
        severity: 'warn',
        reason: `[index-mismatch] ${mdFile} が MEMORY.md から参照されていません`,
        suggestion: `MEMORY.md に (${mdFile}) へのリンクを追加するか、不要なファイルを削除してください。`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Rule: [near-duplicate]
// ---------------------------------------------------------------------------

function lintNearDuplicates(
  assets: Asset[],
  contents: Map<string, string>, // filename → content
  policy: PolicyConfig,
): Finding[] {
  if (assets.length < 2) return [];

  const threshold = policy.memoryLint.duplicateThreshold;

  // Build token sets per asset
  const tokenSets = new Map<string, Set<string>>();
  for (const asset of assets) {
    const filename = basename(asset.path);
    const content = contents.get(filename) ?? '';
    const body = stripFrontmatter(content);
    const normalized = normalizeText(body);
    tokenSets.set(asset.id, tokenize(normalized));
  }

  const findings: Finding[] = [];
  const reported = new Set<string>(); // avoid symmetric duplicates

  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const a = assets[i]!;
      const b = assets[j]!;

      const tokA = tokenSets.get(a.id)!;
      const tokB = tokenSets.get(b.id)!;
      const similarity = jaccard(tokA, tokB);

      if (similarity < threshold) continue;

      const pairKey = [a.id, b.id].sort().join('::');
      if (reported.has(pairKey)) continue;
      reported.add(pairKey);

      const pct = Math.round(similarity * 100);

      // Report on the lexicographically smaller id (deterministic)
      const [candidate, counterpart] = a.id <= b.id ? [a, b] : [b, a];

      findings.push({
        asset: candidate!,
        type: 'lint',
        severity: 'info',
        counterpartId: counterpart!.id,
        reason: `[near-duplicate] "${counterpart!.name}" と ${pct}% 類似しています（閾値 ${Math.round(threshold * 100)}%）`,
        suggestion: `"${candidate!.name}" と "${counterpart!.name}" の内容を統合・整理してください。`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Lint all memory assets and return findings.
 *
 * Applies 4 static rules per DESIGN.md §10.3:
 *   [old-date]        — newest ISO date in body is > oldDateDays ago
 *   [broken-link]     — [[wikilink]] target not found in same directory
 *   [index-mismatch]  — MEMORY.md link broken / .md file unreferenced
 *   [near-duplicate]  — bigram Jaccard similarity >= duplicateThreshold
 *
 * Unreadable files are skipped silently (no throw).
 *
 * @param assets  All scanned assets (non-memory are ignored)
 * @param policy  Policy config (memoryLint.oldDateDays, memoryLint.duplicateThreshold)
 * @param now     Injectable "current date" for testability (defaults to new Date())
 */
export async function lintMemories(
  assets: Asset[],
  policy: PolicyConfig,
  now: Date = new Date(),
): Promise<Finding[]> {
  const memoryAssets = assets.filter((a) => a.kind === 'memory');
  if (memoryAssets.length === 0) return [];

  const dirContexts = buildDirContext(memoryAssets);
  const findings: Finding[] = [];

  for (const [dir, ctx] of dirContexts) {
    // Assets in this directory
    const dirAssets = memoryAssets.filter((a) => dirname(a.path) === dir);

    for (const asset of dirAssets) {
      const filename = basename(asset.path);
      const content = ctx.contents.get(filename);
      if (content === undefined) continue; // unreadable → skip

      // [old-date]
      const oldDateFinding = lintOldDate(asset, content, policy, now);
      if (oldDateFinding) findings.push(oldDateFinding);

      // [broken-link]
      const brokenLinkFindings = lintBrokenLinks(asset, content, ctx);
      findings.push(...brokenLinkFindings);

      // [index-mismatch] — only for MEMORY.md
      if (filename === 'MEMORY.md') {
        const mismatchFindings = lintIndexMismatch(asset, content, ctx);
        findings.push(...mismatchFindings);
      }
    }

    // [near-duplicate] — per-directory pair comparison
    const dupFindings = lintNearDuplicates(dirAssets, ctx.contents, policy);
    findings.push(...dupFindings);
  }

  return findings;
}
