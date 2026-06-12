// duplicates.ts — Duplicate skill detection via Jaccard similarity (DESIGN.md §8.4)
import type { Asset, Finding, UsageStats } from '../types.js';

// ---------------------------------------------------------------------------
// Text normalization and tokenization
// ---------------------------------------------------------------------------

/**
 * Normalize a text string:
 *   1. NFKC Unicode normalization
 *   2. Lowercase
 *   3. Remove non-alphanumeric, non-CJK characters (keep spaces for tokenization)
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\w　-鿿가-힯豈-﫿\s]/g, ' ');
}

/**
 * Extract CJK character bigrams from a string.
 * Consecutive CJK characters form sliding-window bigrams.
 */
function extractCjkBigrams(text: string): string[] {
  const bigrams: string[] = [];
  // Match runs of CJK unified ideographs and related blocks
  const cjkRuns = text.match(/[　-鿿가-힯豈-﫿]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      bigrams.push(run.slice(i, i + 2));
    }
  }
  return bigrams;
}

/**
 * Tokenize a normalized text into a mixed token set:
 *   - ASCII words (from word boundary splitting)
 *   - CJK character bigrams
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();

  // ASCII words
  const asciiWords = text.match(/[a-z0-9]+/g) ?? [];
  for (const word of asciiWords) {
    if (word.length > 0) tokens.add(word);
  }

  // CJK bigrams
  for (const bigram of extractCjkBigrams(text)) {
    tokens.add(bigram);
  }

  return tokens;
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0 if both sets are empty.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Build the comparison text for an asset: name + ' ' + description.
 */
function buildCompareText(asset: Asset): string {
  const description = typeof asset.meta?.['description'] === 'string'
    ? asset.meta['description']
    : '';
  return `${asset.name} ${description}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Detect duplicate skills by Jaccard similarity of their description text.
 *
 * Only assets with kind === 'skill' are compared.
 * For each pair with similarity >= threshold, one Finding is produced:
 *   - The "candidate for archival" is the asset with fewer usages.
 *   - On equal usage count, the older modifiedAt wins (it gets the finding).
 *
 * @param assets    - all assets (non-skill assets are silently skipped)
 * @param stats     - usage stats for lookup
 * @param threshold - Jaccard similarity threshold (default 0.65)
 */
export function detectDuplicates(
  assets: Asset[],
  stats: UsageStats[],
  threshold: number,
): Finding[] {
  // Filter to skills only
  const skills = assets.filter((a) => a.kind === 'skill');
  if (skills.length < 2) return [];

  // Build stats index: name → count
  const statsCountMap = new Map<string, number>();
  for (const s of stats) {
    if (s.kind === 'skill') {
      statsCountMap.set(s.ref, s.count);
    }
  }

  // Pre-compute token sets for each skill
  const tokenSets = new Map<string, Set<string>>();
  for (const skill of skills) {
    const text = normalizeText(buildCompareText(skill));
    tokenSets.set(skill.id, tokenize(text));
  }

  const findings: Finding[] = [];

  // O(n²) pair comparison
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!;
      const b = skills[j]!;

      const tokensA = tokenSets.get(a.id)!;
      const tokensB = tokenSets.get(b.id)!;

      const similarity = jaccard(tokensA, tokensB);
      if (similarity < threshold) continue;

      const similarityPct = Math.round(similarity * 100);

      // Determine which asset is the archive candidate (fewer uses; older if equal)
      const countA = statsCountMap.get(a.name) ?? 0;
      const countB = statsCountMap.get(b.name) ?? 0;

      let candidate: Asset;
      let counterpart: Asset;
      let candidateCount: number;
      let counterpartCount: number;

      if (countA < countB) {
        candidate = a;
        counterpart = b;
        candidateCount = countA;
        counterpartCount = countB;
      } else if (countB < countA) {
        candidate = b;
        counterpart = a;
        candidateCount = countB;
        counterpartCount = countA;
      } else {
        // Equal usage count → older modifiedAt gets the finding
        const modA = new Date(a.modifiedAt).getTime();
        const modB = new Date(b.modifiedAt).getTime();
        if (modA <= modB) {
          candidate = a;
          counterpart = b;
        } else {
          candidate = b;
          counterpart = a;
        }
        candidateCount = countA;
        counterpartCount = countB;
      }

      findings.push({
        asset: candidate,
        type: 'duplicate',
        severity: 'info',
        counterpartId: counterpart.id,
        reason: `スキル "${counterpart.name}" と ${similarityPct}% 類似（使用 ${candidateCount}回 vs ${counterpartCount}回）`,
        suggestion: `"${candidate.name}" は "${counterpart.name}" と内容が重複している可能性があります。統合または削除を検討してください。`,
      });
    }
  }

  return findings;
}
