// types.ts — shared data model (DESIGN.md §3)
export type AssetKind =
  | 'skill' | 'mcp-server' | 'claude-md' | 'memory' | 'command' | 'agent';

export type AssetScope = 'user' | 'project' | 'plugin';

export interface Asset {
  id: string;             // `${kind}:${name}` をベースに一意化（重複時はパスを付加）
  kind: AssetKind;
  name: string;           // skill名 / mcp server名 / ファイル名
  path: string;           // 絶対パス（mcp-server は定義元 JSON のパス）
  scope: AssetScope;
  sizeBytes: number;
  /** 常時ロード分の推定トークン */
  footprintTokens: number;
  /** 呼び出し時にロードされる全文の推定トークン */
  fullTokens: number;
  modifiedAt: string;     // ISO8601
  meta?: Record<string, unknown>; // skill の description、mcp の command 等
}

export interface UsageEvent {
  ts: string;             // ISO8601
  kind: 'skill' | 'mcp-tool' | 'agent';
  ref: string;            // skill名 / mcp server名 / subagent_type
  tool?: string;          // mcp の場合の tool 名
  sessionId: string;
  cwd: string;
}

export interface UsageStats {
  ref: string;
  kind: UsageEvent['kind'];
  count: number;
  lastUsed: string | null;
  projects: string[];
}

export type FindingType = 'stale' | 'unused' | 'bloated' | 'zombie' | 'duplicate';

export interface Finding {
  asset: Asset;
  type: FindingType;
  reason: string;
  severity: 'info' | 'warn' | 'high';
  suggestion: string;
  /** duplicate のとき、相手側 asset の id */
  counterpartId?: string;
}

export interface Inventory {
  assets: Asset[];
  scannedAt: string;      // ISO8601
  warnings: string[];     // parse 失敗等
}

// ─── v0.2: apply / archive / restore (DESIGN.md §8) ─────────────────────────

/** apply が提示する1件の操作提案。Finding から導出される */
export interface Proposal {
  /** 提案の一意キー = finding の asset.id */
  assetId: string;
  asset: Asset;
  action: 'archive';            // v0.2 は archive のみ（merge は将来）
  findingType: FindingType;
  reason: string;
}

/** アーカイブ1件分のメタデータ。~/.curator/archive/<archiveId>/manifest.json */
export interface ArchiveManifest {
  archiveId: string;            // `${YYYYMMDD-HHmmss}-${kind}-${name}` を sanitize
  archivedAt: string;           // ISO8601
  /** restore 済みの場合のみ。listArchives は未復元のみデフォルト表示 */
  restoredAt?: string;
  assetId: string;
  kind: AssetKind;
  name: string;
  findingType: FindingType;     // なぜ archive されたか（provenance）
  reason: string;
  /** ファイル系資産: 移動したエントリ一覧（dir 丸ごとなら1件） */
  entries: Array<{ originalPath: string; archivedPath: string }>;
  /** mcp-server のみ: 除去した設定の復元情報 */
  mcpRestore?: {
    configPath: string;         // 編集した JSON ファイルの絶対パス
    serverName: string;
    serverConfig: unknown;      // 除去した mcpServers[serverName] の値
  };
}

/** ~/.curator/journal.jsonl の1行。apply/restore の append-only 監査ログ */
export interface JournalEntry {
  ts: string;
  op: 'archive' | 'restore';
  archiveId: string;
  assetId: string;
  detail: string;
}
